import { allocate, settleAllocation, notify } from '../supply/supply.db';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { digest, validKey } from '../conversions/conversion.policy';
import { loadProbability } from '../orders/probability';
import { reservedStockSql } from '../commerce/commerce.db';
import {
  CatalogConfig,
  catalogConfig,
  fail,
  integer,
  operationsEnabled,
  shippingTransition,
} from './operations.policy';
import {
  AvailabilityDto,
  DispatchDto,
  OperationsListDto,
  PublishCatalogDto,
  SaveCatalogDto,
} from './operations.dto';
type Permission =
  'CATALOG' | 'FULFILLMENT' | 'WAREHOUSE' | 'ANNOUNCEMENTS' | 'OWNER';
@Injectable()
export class OperationsService {
  constructor(private readonly db: DataSource) {}
  async access(
    m: EntityManager,
    actor: AuthenticatedUser,
    permission: Permission,
    lock = false,
  ) {
    const [u] = await m.query('SELECT auth_version FROM users WHERE id=$1', [
      actor.userId,
    ]);
    if (!u || u.auth_version !== (actor.authVersion ?? 0))
      throw fail('다시 로그인해주세요', 401);
    const [p] = await m.query(
      `SELECT user_id FROM operations_permissions WHERE user_id=$1 AND permission=$2 AND active=true ${lock ? 'FOR SHARE' : ''}`,
      [actor.userId, permission],
    );
    if (!p) throw fail('해당 운영 권한이 필요합니다', 403);
  }
  async capabilities(actor: AuthenticatedUser) {
    const permissions = await this.db.query(
      'SELECT permission FROM operations_permissions WHERE user_id=$1 AND active=true ORDER BY permission',
      [actor.userId],
    );
    return {
      contract: 'OPERATIONS_V1',
      enabled: operationsEnabled(),
      permissions: permissions.map((p) => p.permission),
      carrierSyncEnabled: false,
      physicalStockLedgerEnabled: true,
    };
  }
  async perform(
    actor: AuthenticatedUser,
    permission: Permission,
    key: string,
    payload: unknown,
    run: (m: EntityManager) => Promise<any>,
    owner?: number,
  ) {
    if (!operationsEnabled())
      throw fail('운영 변경 기능은 서버 검증 중입니다', 503);
    key = validKey(key);
    const hash = digest(payload);
    return this.db.transaction(async (m) => {
      // All user locks precede box/order locks; a dispatcher can also be the recipient.
      await m.query(
        'SELECT id FROM users WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE',
        [[...new Set([actor.userId, ...(owner ? [owner] : [])])]],
      );
      await this.access(m, actor, permission, true);
      const [old] = await m.query(
        'SELECT * FROM operations_requests WHERE actor_id=$1 AND request_key=$2',
        [actor.userId, key],
      );
      if (old) {
        if (old.payload_hash !== hash || old.permission !== permission)
          throw fail('같은 요청 번호를 다른 변경에 사용할 수 없습니다');
        return old.response;
      }
      const response = await run(m);
      await m.query(
        'INSERT INTO operations_requests(actor_id,request_key,permission,payload_hash,response) VALUES($1,$2,$3,$4,$5)',
        [actor.userId, key, permission, hash, JSON.stringify(response)],
      );
      return response;
    });
  }
  async byRequest(actor: AuthenticatedUser, key: string) {
    key = validKey(key);
    const [r] = await this.db.query(
      'SELECT permission,response FROM operations_requests WHERE actor_id=$1 AND request_key=$2',
      [actor.userId, key],
    );
    if (!r) throw fail('확인된 운영 요청이 없습니다', 404);
    await this.access(this.db.manager, actor, r.permission);
    return r.response;
  }
  async event(
    m: EntityManager,
    actor: number,
    type: Permission,
    id: string | number,
    event: string,
    detail: unknown,
  ) {
    await m.query(
      'INSERT INTO operations_events(actor_id,target_type,target_id,event,detail) VALUES($1,$2,$3,$4,$5)',
      [actor, type, String(id), event, JSON.stringify(detail)],
    );
  }
  private async usedStock(m: EntityManager, id: number) {
    const [{ n }] = await m.query(
      'SELECT COALESCE(sum(quantity-refunded_quantity),0)+(SELECT count(*) FROM draws WHERE gacha_id=$1) AS n FROM capsule_orders WHERE gacha_id=$1',
      [id],
    );
    const [{ reserved }] = await m.query(reservedStockSql, [id]);
    return Number(n) + Number(reserved);
  }
  private async box(m: EntityManager, id: number, lock = false) {
    integer(id, 1);
    const [g] = await m.query(
      `SELECT * FROM gachas WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!g) throw fail('박스를 찾을 수 없습니다', 404);
    return g;
  }
  private async detail(m: EntityManager, id: number) {
    const g = await this.box(m, id),
      [d] = await m.query('SELECT * FROM catalog_drafts WHERE gacha_id=$1', [
        id,
      ]);
    const entries = await m.query(
      `SELECT i.name,i.rarity,i."imageUrl",i."estimatedValue",i."isPremium",p."probabilityPpm",i.fulfillment_type AS "fulfillmentType",i.shipping_enabled AS "shippingEnabled",i.warehouse_sku_id AS "warehouseSkuId" FROM gacha_items p JOIN items i ON i.id=p.item_id WHERE p.gacha_id=$1 ORDER BY i.id`,
      [id],
    );
    const events = await m.query(
      `SELECT id,event,detail,created_at AS "createdAt" FROM operations_events WHERE target_type='CATALOG' AND target_id=$1 ORDER BY id DESC LIMIT 20`,
      [String(id)],
    );
    return {
      gachaId: g.id,
      title: g.title,
      active: g.active,
      cashEnabled: g.cash_enabled,
      price: g.price,
      totalStock: g.totalStock,
      committedStock: await this.usedStock(m, id),
      version: d?.version ?? 0,
      publishedVersion: d?.published_version ?? null,
      hasUnpublishedChanges: d?.dirty ?? false,
      draft: d?.config ?? {
        title: g.title,
        description: g.description ?? '',
        imageUrl: g.imageUrl,
        price: g.price,
        totalStock: g.totalStock,
        saleType: g.sale_type,
        entries,
      },
      events,
    };
  }
  async catalog(actor: AuthenticatedUser, q: OperationsListDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, actor, 'CATALOG');
      const [{ n }] = await m.query('SELECT count(*) AS n FROM gachas');
      const rows = await m.query(
        `SELECT g.id AS "gachaId",g.title,g.active,g.price,g."totalStock",COALESCE(d.version,0) AS version,COALESCE(d.dirty,false) AS "hasUnpublishedChanges" FROM gachas g LEFT JOIN catalog_drafts d ON d.gacha_id=g.id ORDER BY g.id DESC OFFSET $1 LIMIT $2`,
        [(q.page - 1) * q.limit, q.limit],
      );
      return {
        items: rows,
        totalCount: Number(n),
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async catalogDetail(actor: AuthenticatedUser, id: number) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, actor, 'CATALOG');
      return this.detail(m, id);
    });
  }
  async create(actor: AuthenticatedUser, key: string, value: CatalogConfig) {
    const config = catalogConfig(value);
    return this.perform(
      actor,
      'CATALOG',
      key,
      { op: 'create', config },
      async (m) => {
        const [g] = await m.query(
          `INSERT INTO gachas(title,description,price,currency,active,"imageUrl","totalStock",sale_type,cash_enabled) VALUES($1,$2,$3,'GP',false,$4,$5,$6,false) RETURNING id`,
          [
            config.title,
            config.description,
            config.price,
            config.imageUrl,
            config.totalStock,
            config.saleType,
          ],
        );
        await m.query(
          'INSERT INTO catalog_drafts(gacha_id,version,config) VALUES($1,1,$2)',
          [g.id, JSON.stringify(config)],
        );
        await this.event(m, actor.userId, 'CATALOG', g.id, 'DRAFT_CREATED', {
          version: 1,
          config,
        });
        return { gachaId: g.id, version: 1, active: false };
      },
    );
  }
  async save(
    actor: AuthenticatedUser,
    id: number,
    key: string,
    dto: SaveCatalogDto,
  ) {
    const config = catalogConfig(dto.config);
    integer(dto.expectedVersion, 0);
    return this.perform(
      actor,
      'CATALOG',
      key,
      { op: 'save', id, version: dto.expectedVersion, config },
      async (m) => {
        await this.box(m, id, true);
        const [d] = await m.query(
          'SELECT version FROM catalog_drafts WHERE gacha_id=$1 FOR UPDATE',
          [id],
        );
        if ((d?.version ?? 0) !== dto.expectedVersion)
          throw fail('다른 운영자가 변경했습니다. 최신 내용을 확인해주세요');
        const version = dto.expectedVersion + 1;
        await m.query(
          `INSERT INTO catalog_drafts(gacha_id,version,config) VALUES($1,$2,$3) ON CONFLICT(gacha_id) DO UPDATE SET version=$2,config=$3,dirty=true,updated_at=clock_timestamp()`,
          [id, version, JSON.stringify(config)],
        );
        await this.event(m, actor.userId, 'CATALOG', id, 'DRAFT_SAVED', {
          version,
          config,
        });
        return { gachaId: id, version };
      },
    );
  }
  async publish(
    actor: AuthenticatedUser,
    id: number,
    key: string,
    dto: PublishCatalogDto,
  ) {
    if (dto.confirmation !== '판매 설정 적용')
      throw fail('판매 설정 적용 안내를 확인해주세요', 400);
    return this.perform(
      actor,
      'CATALOG',
      key,
      { op: 'publish', id, ...dto },
      async (m) => {
        const g = await this.box(m, id, true),
          [d] = await m.query(
            'SELECT * FROM catalog_drafts WHERE gacha_id=$1 FOR UPDATE',
            [id],
          );
        if (!d || d.version !== dto.expectedVersion || !d.dirty)
          throw fail('최신 미적용 초안을 확인해주세요');
        const c = catalogConfig(d.config, true),
          used = await this.usedStock(m, id);
        if (c.totalStock < used)
          throw fail('총 판매 수량을 판매·결제 예약 수량보다 줄일 수 없습니다');
        if (g.cash_enabled)
          throw fail('카드 판매를 중지한 박스의 설정만 변경할 수 있습니다');
        // New prize rows leave existing purchased snapshots and inventory references intact.
        await m.query('DELETE FROM gacha_items WHERE gacha_id=$1', [id]);
        for (const e of c.entries) {
          if (e.warehouseSkuId) {
            const [sku] = await m.query(
              'SELECT id FROM warehouse_skus WHERE id=$1',
              [e.warehouseSkuId],
            );
            if (!sku) throw fail('실물 재고 코드를 확인해주세요');
          }
          const conversionGP = e.isPremium
            ? e.estimatedValue
            : Math.floor(e.estimatedValue / 10);
          const [p] = await m.query(
            `INSERT INTO items(name,rarity,"imageUrl","estimatedValue","isPremium","conversionGP",fulfillment_type,shipping_enabled,warehouse_sku_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              e.name,
              e.rarity,
              e.imageUrl,
              e.estimatedValue,
              e.isPremium,
              conversionGP,
              e.fulfillmentType,
              e.shippingEnabled,
              e.warehouseSkuId ?? null,
            ],
          );
          await m.query(
            `INSERT INTO gacha_items(gacha_id,item_id,weight,"probabilityPpm") VALUES($1,$2,1,$3)`,
            [id, p.id, e.probabilityPpm],
          );
        }
        await m.query(
          `UPDATE gachas SET title=$2,description=$3,price=$4,currency='GP',"imageUrl"=$5,"totalStock"=$6,sale_type=$7,"updatedAt"=clock_timestamp() WHERE id=$1`,
          [
            id,
            c.title,
            c.description,
            c.price,
            c.imageUrl,
            c.totalStock,
            c.saleType,
          ],
        );
        const version = d.version + 1,
          p = await loadProbability(m, id);
        await m.query(
          'UPDATE catalog_drafts SET version=$2,published_version=$2,dirty=false,updated_at=clock_timestamp() WHERE gacha_id=$1',
          [id, version],
        );
        await this.event(m, actor.userId, 'CATALOG', id, 'PUBLISHED', {
          version,
          probabilityVersion: p.version,
          totalStock: c.totalStock,
          committedStock: used,
          snapshot: p.snapshot,
        });
        return {
          gachaId: id,
          version,
          probabilityVersion: p.version,
          active: g.active,
        };
      },
    );
  }
  async availability(
    actor: AuthenticatedUser,
    id: number,
    key: string,
    dto: AvailabilityDto,
  ) {
    return this.perform(
      actor,
      'CATALOG',
      key,
      { op: 'availability', id, ...dto },
      async (m) => {
        const g = await this.box(m, id, true),
          [d] = await m.query(
            'SELECT * FROM catalog_drafts WHERE gacha_id=$1 FOR UPDATE',
            [id],
          );
        if ((d?.version ?? 0) !== dto.expectedVersion)
          throw fail('최신 박스 상태를 확인해주세요');
        if (dto.active) {
          if (!d?.published_version || d.dirty)
            throw fail('초안을 먼저 적용한 뒤 판매를 시작해주세요');
          await loadProbability(m, id);
          if ((await this.usedStock(m, id)) >= g.totalStock)
            throw fail('판매 가능한 수량이 없습니다');
        }
        // Pausing unmanaged legacy catalog is allowed; resuming requires a reviewed draft.
        await m.query(
          'UPDATE gachas SET active=$2,"updatedAt"=clock_timestamp() WHERE id=$1',
          [id, dto.active],
        );
        if (d)
          await m.query(
            'UPDATE catalog_drafts SET version=version+1,updated_at=clock_timestamp() WHERE gacha_id=$1',
            [id],
          );
        await this.event(
          m,
          actor.userId,
          'CATALOG',
          id,
          dto.active ? 'RESUMED' : 'PAUSED',
          {
            previous: g.active,
            active: dto.active,
            version: d ? d.version + 1 : 0,
          },
        );
        return {
          gachaId: id,
          version: d ? d.version + 1 : 0,
          active: dto.active,
        };
      },
    );
  }
  async shipments(actor: AuthenticatedUser, q: OperationsListDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, actor, 'FULFILLMENT');
      const params = [q.status ?? null],
        where = '($1::varchar IS NULL OR status=$1)';
      const [{ n }] = await m.query(
        'SELECT count(*) AS n FROM fulfillment_orders WHERE ' + where,
        params,
      );
      const rows = await m.query(
        `SELECT id AS "fulfillmentId",status,operations_version AS version,created_at AS "createdAt",carrier,tracking_number AS "trackingNumber",(SELECT count(*) FROM fulfillment_order_items i WHERE i.fulfillment_id=f.id) AS "itemCount" FROM fulfillment_orders f WHERE ${where} ORDER BY created_at,id OFFSET $2 LIMIT $3`,
        [...params, (q.page - 1) * q.limit, q.limit],
      );
      return {
        items: rows,
        totalCount: Number(n),
        page: q.page,
        limit: q.limit,
      };
    });
  }
  async shipment(actor: AuthenticatedUser, id: string) {
    id = validKey(id);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, actor, 'FULFILLMENT');
      const [r] = await m.query(
        'SELECT * FROM fulfillment_orders WHERE id=$1',
        [id],
      );
      if (!r) throw fail('배송 신청을 찾을 수 없습니다', 404);
      const items = await m.query(
        'SELECT inventory_item_id AS "inventoryItemId",prize FROM fulfillment_order_items WHERE fulfillment_id=$1 ORDER BY inventory_item_id',
        [id],
      );
      const events = await m.query(
        `SELECT event,detail,created_at AS "createdAt" FROM operations_events WHERE target_type='FULFILLMENT' AND target_id=$1 ORDER BY id`,
        [id],
      );
      return {
        fulfillmentId: r.id,
        status: r.status,
        version: r.operations_version,
        allocations: await m.query(
          'SELECT a.sku_id AS "skuId",s.code,s.name,a.quantity,a.state FROM warehouse_allocations a JOIN warehouse_skus s ON s.id=a.sku_id WHERE a.fulfillment_id=$1 ORDER BY a.sku_id',
          [id],
        ),
        recipient: r.recipient,
        items,
        carrier: r.carrier,
        trackingNumber: r.tracking_number,
        createdAt: r.created_at,
        events,
      };
    });
  }
  async dispatch(
    actor: AuthenticatedUser,
    id: string,
    key: string,
    dto: DispatchDto,
  ) {
    id = validKey(id);
    const [found] = await this.db.query(
      'SELECT user_id FROM fulfillment_orders WHERE id=$1',
      [id],
    );
    // Check role before revealing whether a target exists.
    await this.access(this.db.manager, actor, 'FULFILLMENT');
    if (!found) throw fail('배송 신청을 찾을 수 없습니다', 404);
    return this.perform(
      actor,
      'FULFILLMENT',
      key,
      { op: 'dispatch', id, ...dto },
      async (m) => {
        const [r] = await m.query(
          'SELECT * FROM fulfillment_orders WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (r.operations_version !== dto.expectedVersion)
          throw fail('배송 상태가 변경되었습니다. 최신 상태를 확인해주세요');
        shippingTransition(
          r.status,
          dto.status,
          dto.carrier,
          dto.trackingNumber,
        );
        const items = await m.query(
          'SELECT i.id,i.status,x.active FROM fulfillment_order_items x JOIN inventory_items i ON i.id=x.inventory_item_id WHERE x.fulfillment_id=$1 ORDER BY i.id FOR UPDATE OF i',
          [id],
        );
        const expected = ['REQUESTED', 'PREPARING'].includes(r.status)
          ? 'SHIPPING_REQUESTED'
          : 'SHIPPING';
        if (
          !items.length ||
          items.some((i) => !i.active || i.status !== expected)
        )
          throw fail('상품 상태와 배송 요청이 일치하지 않습니다');
        if (dto.status === 'PREPARING') await allocate(m, id, actor.userId);
        if (dto.status === 'COLLECTED')
          await settleAllocation(m, id, actor.userId, true);
        const status =
          dto.status === 'DELIVERED'
            ? 'DELIVERED'
            : dto.status === 'PREPARING'
              ? 'SHIPPING_REQUESTED'
              : 'SHIPPING';
        await m.query(
          'UPDATE inventory_items SET status=$1 WHERE id=ANY($2::integer[])',
          [status, items.map((i) => i.id)],
        );
        await m.query(
          `UPDATE fulfillment_orders SET status=$2::varchar,operations_version=operations_version+1,carrier=COALESCE($3,carrier),tracking_number=COALESCE($4,tracking_number),dispatched_at=CASE WHEN $2::varchar='COLLECTED' THEN clock_timestamp() ELSE dispatched_at END,delivered_at=CASE WHEN $2::varchar='DELIVERED' THEN clock_timestamp() ELSE delivered_at END WHERE id=$1`,
          [id, dto.status, dto.carrier ?? null, dto.trackingNumber ?? null],
        );
        await this.event(m, actor.userId, 'FULFILLMENT', id, dto.status, {
          from: r.status,
          to: dto.status,
          version: r.operations_version + 1,
          source: 'OPERATOR',
        });
        await notify(
          m,
          r.user_id,
          `shipment:${id}:${dto.status}`,
          'SHIPMENT_UPDATE',
          id,
          '배송 상태가 변경됐어요',
          {
            PREPARING: '상품을 준비하고 있습니다.',
            COLLECTED: '택배사에 상품을 전달했습니다.',
            SHIPPING: '상품이 이동 중입니다.',
            DELIVERED: '배송이 완료됐습니다.',
          }[dto.status],
        );
        return {
          fulfillmentId: id,
          status: dto.status,
          version: r.operations_version + 1,
        };
      },
      found.user_id,
    );
  }
}
