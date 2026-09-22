import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'crypto';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { OperationsService } from '../operations/operations.service';
import { accountLock, plain } from '../account-support/account-support.policy';
import { fail, integer } from '../operations/operations.policy';
import { validKey } from '../conversions/conversion.policy';
import { allocate, move } from './supply.db';
import {
  AnnouncementDto,
  AnnouncementStateDto,
  CreateSkuDto,
  EditAnnouncementDto,
  LinkSkuDto,
  StockMovementDto,
  SupplyListDto,
} from './supply.dto';
@Injectable()
export class SupplyService {
  constructor(
    private readonly db: DataSource,
    private readonly ops: OperationsService,
  ) {}
  private async user(m: EntityManager, a: AuthenticatedUser) {
    const [u] = await m.query('SELECT auth_version FROM users WHERE id=$1', [
      a.userId,
    ]);
    if (!u || u.auth_version !== (a.authVersion ?? 0))
      throw fail('다시 로그인해주세요', 401);
  }
  private async list(
    m: EntityManager,
    sql: string,
    params: any[],
    q: SupplyListDto,
  ) {
    integer(q.page, 1, 100000);
    integer(q.limit, 1, 100);
    const [{ n }] = await m.query(
      `SELECT count(*)::int AS n FROM (${sql}) t`,
      params,
    );
    return {
      items: await m.query(
        `${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, (q.page - 1) * q.limit],
      ),
      totalCount: n,
      page: q.page,
      limit: q.limit,
    };
  }
  async skus(a: AuthenticatedUser, q: SupplyListDto, catalog = false) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.ops.access(m, a, catalog ? 'CATALOG' : 'WAREHOUSE');
      return this.list(
        m,
        `SELECT id AS "skuId",code,name,on_hand AS "onHand",reserved,on_hand-reserved AS available,reorder_point AS "reorderPoint",version FROM warehouse_skus ${q.low === 'true' ? 'WHERE on_hand-reserved<=reorder_point' : ''} ORDER BY id DESC`,
        [],
        q,
      );
    });
  }
  async sku(a: AuthenticatedUser, id: number) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.ops.access(m, a, 'WAREHOUSE');
      const [s] = await m.query(
        'SELECT id AS "skuId",code,name,on_hand AS "onHand",reserved,on_hand-reserved AS available,reorder_point AS "reorderPoint",version FROM warehouse_skus WHERE id=$1',
        [id],
      );
      if (!s) throw fail('재고 코드를 찾을 수 없습니다', 404);
      return {
        ...s,
        movements: await m.query(
          'SELECT id,kind,delta_on_hand AS "deltaOnHand",delta_reserved AS "deltaReserved",on_hand_after AS "onHandAfter",reserved_after AS "reservedAfter",reason,created_at AS "createdAt" FROM warehouse_movements WHERE sku_id=$1 ORDER BY id DESC LIMIT 30',
          [id],
        ),
      };
    });
  }
  async createSku(a: AuthenticatedUser, key: string, d: CreateSkuDto) {
    const code = plain(d.code, 2, 40),
      name = plain(d.name, 1, 255);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code))
      throw fail('재고 코드를 확인해주세요', 400);
    integer(d.reorderPoint, 0, 10000000);
    return this.ops.perform(
      a,
      'WAREHOUSE',
      key,
      { op: 'sku-create', code, name, reorderPoint: d.reorderPoint },
      async (m) => {
        const [s] = await m.query(
          'INSERT INTO warehouse_skus(code,name,reorder_point) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING RETURNING id',
          [code, name, d.reorderPoint],
        );
        if (!s) throw fail('이미 등록된 재고 코드입니다');
        await this.ops.event(m, a.userId, 'WAREHOUSE', s.id, 'SKU_CREATED', {
          code,
          name,
        });
        return { skuId: s.id, version: 1 };
      },
    );
  }
  async movement(
    a: AuthenticatedUser,
    id: number,
    key: string,
    d: StockMovementDto,
  ) {
    integer(d.quantity, -10000000, 10000000);
    if (
      !['RECEIVE', 'ADJUST'].includes(d.kind) ||
      d.quantity === 0 ||
      (d.kind === 'RECEIVE' && d.quantity < 1)
    )
      throw fail('입고는 양수, 조정은 0이 아닌 수량을 입력해주세요', 400);
    const reason = plain(d.reason, 1, 255);
    return this.ops.perform(
      a,
      'WAREHOUSE',
      key,
      { op: 'stock-move', id, ...d, reason },
      async (m) => {
        const [s] = await m.query(
          'SELECT * FROM warehouse_skus WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (!s) throw fail('재고 코드를 찾을 수 없습니다', 404);
        if (s.version !== d.expectedVersion)
          throw fail('재고가 변경됐습니다. 최신 수량을 확인해주세요');
        await move(m, s, a.userId, d.kind, key, d.quantity, 0, reason);
        await this.ops.event(m, a.userId, 'WAREHOUSE', id, d.kind, {
          quantity: d.quantity,
          reason,
          version: s.version + 1,
        });
        return { skuId: id, version: s.version + 1 };
      },
    );
  }
  async items(a: AuthenticatedUser, q: SupplyListDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.ops.access(m, a, 'WAREHOUSE');
      return this.list(
        m,
        `SELECT i.id AS "itemId",i.name,i.warehouse_sku_id AS "skuId",s.code,i.warehouse_link_version AS version FROM items i LEFT JOIN warehouse_skus s ON s.id=i.warehouse_sku_id WHERE i.fulfillment_type='PHYSICAL' ORDER BY i.id DESC`,
        [],
        q,
      );
    });
  }
  async link(a: AuthenticatedUser, id: number, key: string, d: LinkSkuDto) {
    return this.ops.perform(
      a,
      'WAREHOUSE',
      key,
      { op: 'sku-link', id, ...d },
      async (m) => {
        const [i] = await m.query(
          'SELECT * FROM items WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (!i || i.fulfillment_type !== 'PHYSICAL')
          throw fail('실물 상품을 찾을 수 없습니다', 404);
        if (i.warehouse_link_version !== d.expectedVersion)
          throw fail('상품 연결이 변경됐습니다. 다시 확인해주세요');
        const [s] = await m.query('SELECT id FROM warehouse_skus WHERE id=$1', [
          d.skuId,
        ]);
        if (!s) throw fail('재고 코드를 찾을 수 없습니다', 404);
        await m.query(
          'UPDATE items SET warehouse_sku_id=$2,warehouse_link_version=warehouse_link_version+1 WHERE id=$1',
          [id, d.skuId],
        );
        await this.ops.event(m, a.userId, 'WAREHOUSE', id, 'ITEM_LINKED', {
          from: i.warehouse_sku_id,
          to: d.skuId,
        });
        return { itemId: id, skuId: d.skuId, version: d.expectedVersion + 1 };
      },
    );
  }
  async reserve(
    a: AuthenticatedUser,
    id: string,
    key: string,
    version: number,
  ) {
    id = validKey(id);
    await this.ops.access(this.db.manager, a, 'WAREHOUSE');
    const [r] = await this.db.query(
      'SELECT user_id FROM fulfillment_orders WHERE id=$1',
      [id],
    );
    if (!r) throw fail('배송 신청을 찾을 수 없습니다', 404);
    return this.ops.perform(
      a,
      'WAREHOUSE',
      key,
      { op: 'reserve', id, version },
      async (m) => {
        const [f] = await m.query(
          'SELECT * FROM fulfillment_orders WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (f.status !== 'PREPARING' || f.operations_version !== version)
          throw fail('준비 중인 최신 배송만 재고 예약할 수 있습니다');
        await m.query(
          'SELECT i.id FROM fulfillment_order_items x JOIN inventory_items i ON i.id=x.inventory_item_id WHERE x.fulfillment_id=$1 ORDER BY i.id FOR UPDATE OF i',
          [id],
        );
        await allocate(m, id, a.userId);
        await m.query(
          'UPDATE fulfillment_orders SET operations_version=operations_version+1 WHERE id=$1',
          [id],
        );
        await this.ops.event(m, a.userId, 'WAREHOUSE', id, 'RESERVED', {
          version: version + 1,
        });
        return { fulfillmentId: id, version: version + 1 };
      },
      r.user_id,
    );
  }
  async capabilities(a: AuthenticatedUser) {
    await this.user(this.db.manager, a);
    return {
      contract: 'INBOX_V1',
      enabled: true,
      pushEnabled: false,
      smsEnabled: false,
    };
  }
  async notifications(a: AuthenticatedUser, q: SupplyListDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.user(m, a);
      return this.list(
        m,
        `SELECT id::float8 AS id,kind,title,body,target_id AS "targetId",read_at AS "readAt",created_at AS "createdAt" FROM app_notifications WHERE user_id=$1 ${q.unread === 'true' ? 'AND read_at IS NULL' : ''} ORDER BY id DESC`,
        [a.userId],
        q,
      );
    });
  }
  async summary(a: AuthenticatedUser) {
    await this.user(this.db.manager, a);
    const [r] = await this.db.query(
      `SELECT (SELECT count(*)::int FROM app_notifications WHERE user_id=$1 AND read_at IS NULL) AS "notifications",(SELECT count(*)::int FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=$1 WHERE a.status='PUBLISHED' AND r.announcement_id IS NULL) AS "announcements"`,
      [a.userId],
    );
    return r;
  }
  async read(a: AuthenticatedUser, through: number) {
    integer(through, 0, Number.MAX_SAFE_INTEGER);
    return this.db.transaction(async (m) => {
      await accountLock(m, a);
      const [{ n }] = await m.query(
        'SELECT COALESCE(max(id),0)::float8 AS n FROM app_notifications WHERE user_id=$1',
        [a.userId],
      );
      if (through > n) throw fail('확인한 알림을 다시 불러와주세요', 400);
      await m.query(
        'UPDATE app_notifications SET read_at=clock_timestamp() WHERE user_id=$1 AND id<=$2 AND read_at IS NULL',
        [a.userId, through],
      );
      return { readThrough: through };
    });
  }
  async announcements(a: AuthenticatedUser, q: SupplyListDto, staff = false) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      if (staff) await this.ops.access(m, a, 'ANNOUNCEMENTS');
      else await this.user(m, a);
      return this.list(
        m,
        `SELECT a.id AS "announcementId",a.title,a.body,a.category,a.status,a.version,a.published_at AS "publishedAt",a.created_at AS "createdAt",r.read_at AS "readAt" FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=$1 ${staff ? '' : "WHERE a.status='PUBLISHED'"} ORDER BY a.created_at DESC,a.id DESC`,
        [a.userId],
        q,
      );
    });
  }
  async announcement(a: AuthenticatedUser, id: string, staff = false) {
    await (staff
      ? this.ops.access(this.db.manager, a, 'ANNOUNCEMENTS')
      : this.user(this.db.manager, a));
    const [r] = await this.db.query(
      `SELECT id AS "announcementId",title,body,category,status,version,published_at AS "publishedAt",created_at AS "createdAt" FROM announcements WHERE id=$1 ${staff ? '' : "AND status='PUBLISHED'"}`,
      [validKey(id)],
    );
    if (!r) throw fail('공지를 찾을 수 없습니다', 404);
    return r;
  }
  async readAnnouncement(a: AuthenticatedUser, id: string) {
    return this.db.transaction(async (m) => {
      await accountLock(m, a);
      const [r] = await m.query(
        "SELECT id FROM announcements WHERE id=$1 AND status='PUBLISHED' FOR SHARE",
        [validKey(id)],
      );
      if (!r) throw fail('공지를 찾을 수 없습니다', 404);
      await m.query(
        'INSERT INTO announcement_reads(user_id,announcement_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [a.userId, id],
      );
      return { announcementId: id, read: true };
    });
  }
  private content(d: AnnouncementDto) {
    if (!['NOTICE', 'MAINTENANCE'].includes(d.category))
      throw fail('공지 유형을 확인해주세요', 400);
    return {
      title: plain(d.title, 1, 120),
      body: plain(d.body, 1, 5000, true),
      category: d.category,
    };
  }
  async saveAnnouncement(
    a: AuthenticatedUser,
    id: string | null,
    key: string,
    d: AnnouncementDto | EditAnnouncementDto,
  ) {
    const c = this.content(d);
    return this.ops.perform(
      a,
      'ANNOUNCEMENTS',
      key,
      {
        op: 'announcement-save',
        id,
        ...c,
        version: (d as EditAnnouncementDto).expectedVersion ?? null,
      },
      async (m) => {
        let version = 1;
        if (id) {
          const [r] = await m.query(
            'SELECT * FROM announcements WHERE id=$1 FOR UPDATE',
            [validKey(id)],
          );
          if (!r) throw fail('공지를 찾을 수 없습니다', 404);
          if (
            r.status !== 'DRAFT' ||
            r.version !== (d as EditAnnouncementDto).expectedVersion
          )
            throw fail('최신 초안만 수정할 수 있습니다');
          version = r.version + 1;
          await m.query(
            'UPDATE announcements SET title=$2,body=$3,category=$4,version=$5,updated_at=clock_timestamp() WHERE id=$1',
            [id, c.title, c.body, c.category, version],
          );
        } else {
          id = randomUUID();
          await m.query(
            'INSERT INTO announcements(id,title,body,category) VALUES($1,$2,$3,$4)',
            [id, c.title, c.body, c.category],
          );
        }
        await this.ops.event(m, a.userId, 'ANNOUNCEMENTS', id, 'DRAFT_SAVED', {
          version,
        });
        return { announcementId: id, version, status: 'DRAFT' };
      },
    );
  }
  async announcementStatus(
    a: AuthenticatedUser,
    id: string,
    key: string,
    d: AnnouncementStateDto,
  ) {
    if (d.confirmed !== true) throw fail('공지 적용 내용을 확인해주세요', 400);
    return this.ops.perform(
      a,
      'ANNOUNCEMENTS',
      key,
      { op: 'announcement-status', id, ...d },
      async (m) => {
        const [r] = await m.query(
          'SELECT * FROM announcements WHERE id=$1 FOR UPDATE',
          [validKey(id)],
        );
        if (!r) throw fail('공지를 찾을 수 없습니다', 404);
        if (
          r.version !== d.expectedVersion ||
          !(
            (r.status === 'DRAFT' && d.status === 'PUBLISHED') ||
            (r.status === 'PUBLISHED' && d.status === 'ARCHIVED')
          )
        )
          throw fail('최신 공지의 다음 상태만 적용할 수 있습니다');
        await m.query(
          `UPDATE announcements SET status=$2::varchar,version=version+1,published_at=CASE WHEN $2::varchar='PUBLISHED' THEN clock_timestamp() ELSE published_at END,updated_at=clock_timestamp() WHERE id=$1`,
          [id, d.status],
        );
        await this.ops.event(m, a.userId, 'ANNOUNCEMENTS', id, d.status, {
          version: r.version + 1,
        });
        return { announcementId: id, version: r.version + 1, status: d.status };
      },
    );
  }
}
