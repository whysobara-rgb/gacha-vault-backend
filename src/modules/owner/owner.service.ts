import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { OperationsService } from '../operations/operations.service';
import {
  fail,
  integer,
  operationsEnabled,
  image,
} from '../operations/operations.policy';
import { plain } from '../account-support/account-support.policy';
import { move } from '../supply/supply.db';
import {
  CampaignDto,
  CampaignStateDto,
  EditCampaignDto,
  OwnerPageDto,
  PauseSalesDto,
  ProcurementChangeDto,
  ProcurementDto,
} from './owner.dto';
const procurementSelect = `SELECT p.id,p.sku_id AS "skuId",s.code,s.name,p.supplier,p.reference,p.quantity,p.received,p.unit_cost_krw AS "unitCostKRW",p.expected_at AS "expectedAt",p.status,p.version,p.created_at AS "createdAt" FROM supplier_orders p JOIN warehouse_skus s ON s.id=p.sku_id`;
const campaignSelect = `SELECT id,title,body,kind,gacha_id AS "gachaId",starts_at AS "startsAt",ends_at AS "endsAt",budget_krw AS "budgetKRW",image_url AS "imageUrl",home_visible AS "homeVisible",sort_order AS "sortOrder",status,version,created_at AS "createdAt" FROM owner_campaigns`;
function timestamp(value: string) {
  if (
    typeof value !== 'string' ||
    !/(Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw fail('시간대가 포함된 날짜를 입력해주세요', 400);
  return new Date(value).toISOString();
}
@Injectable()
export class OwnerService {
  constructor(
    private readonly db: DataSource,
    private readonly ops: OperationsService,
  ) {}
  private async access(m: EntityManager, a: AuthenticatedUser) {
    await this.ops.access(m, a, 'OWNER');
  }
  async capabilities(a: AuthenticatedUser) {
    await this.access(this.db.manager, a);
    return {
      contract: 'OWNER_CONSOLE_V1',
      enabled: operationsEnabled(),
      supplierOrdering: 'MANUAL_EXTERNAL',
      campaignRewards: false,
      productionReady: false,
      traceContract: 'OWNER_ORDER_TRACE_V1',
      caseTracking: true,
      homeBannerPublishing: true,
    };
  }
  private async page(
    m: EntityManager,
    sql: string,
    params: any[],
    q: OwnerPageDto,
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
  async overview(a: AuthenticatedUser) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      const [work] = await m.query(`SELECT
        (SELECT count(*)::int FROM fulfillment_orders WHERE status='REQUESTED') AS "shipRequested",
        (SELECT count(*)::int FROM fulfillment_orders WHERE status='PREPARING') AS "shipPreparing",
        (SELECT count(*)::int FROM fulfillment_orders WHERE status IN('REQUESTED','PREPARING') AND created_at<now()-interval '48 hours') AS "shipOverdue",
        (SELECT count(*)::int FROM owner_cases WHERE status<>'CLOSED') AS "openCases",
        (SELECT count(*)::int FROM support_tickets WHERE status='OPEN') AS "openTickets",
        (SELECT count(*)::int FROM support_tickets WHERE status='OPEN' AND updated_at<now()-interval '24 hours') AS "ticketOverdue",
        (SELECT count(*)::int FROM warehouse_skus WHERE on_hand-reserved<=reorder_point) AS "lowStock",
        (SELECT count(*)::int FROM supplier_orders WHERE status IN('ORDERED','PARTIAL') AND expected_at<now()) AS "lateProcurement",
        (SELECT count(*)::int FROM payment_intents WHERE status IN('UNKNOWN','CONFIRMING','APPROVED')) AS "paymentReview",
        (SELECT count(*)::int FROM order_refunds WHERE status<>'SUCCEEDED') AS "refundReview",
        (SELECT count(*)::int FROM account_closure_requests WHERE status='REQUESTED') AS "accountClosures",
        (SELECT count(*)::int FROM auth_mail_jobs WHERE status='FAILED') AS "failedMail",
        (SELECT count(*)::int FROM gachas WHERE active=true) AS "activeBoxes"`);
      const [sales] = await m.query(`SELECT
        (SELECT count(*)::int FROM capsule_orders WHERE created_at>=now()-interval '7 days') AS "orders7d",
        (SELECT count(DISTINCT user_id)::int FROM capsule_orders WHERE created_at>=now()-interval '7 days') AS "buyers7d",
        (SELECT COALESCE(sum(total),0)::text FROM capsule_orders WHERE currency='KRW' AND created_at>=now()-interval '7 days') AS "grossKRW7d",
        (SELECT COALESCE(sum(amount),0)::text FROM order_refunds WHERE currency='KRW' AND status='SUCCEEDED' AND completed_at>=now()-interval '7 days') AS "refundKRW7d",
        (SELECT COALESCE(sum(total),0)::text FROM capsule_orders WHERE currency='GP' AND created_at>=now()-interval '7 days') AS "spentGP7d",
        (SELECT COALESCE(sum("coinBalance"),0)::text FROM users) AS "outstandingGP"`);
      return {
        asOf: new Date().toISOString(),
        work,
        sales,
        analyticsScope: 'SERVER_ORDERS_7D',
        acquisitionMetricsAvailable: false,
        netProfitAvailable: false,
      };
    });
  }
  async procurements(a: AuthenticatedUser, q: OwnerPageDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      return this.page(
        m,
        procurementSelect + ' ORDER BY p.created_at DESC,p.id DESC',
        [],
        q,
      );
    });
  }
  async createProcurement(
    a: AuthenticatedUser,
    key: string,
    d: ProcurementDto,
  ) {
    const payload = {
      skuId: integer(d.skuId, 1),
      supplier: plain(d.supplier, 1, 120),
      reference: plain(d.reference, 0, 120, true),
      quantity: integer(d.quantity, 1, 100000),
      unitCostKRW: integer(d.unitCostKRW, 0, 100000000),
      expectedAt: timestamp(d.expectedAt),
    };
    return this.ops.perform(
      a,
      'OWNER',
      key,
      { op: 'procurement-create', ...payload },
      async (m) => {
        const [sku] = await m.query(
          'SELECT id FROM warehouse_skus WHERE id=$1',
          [payload.skuId],
        );
        if (!sku) throw fail('실물 재고 코드를 먼저 등록해주세요', 404);
        const id = randomUUID();
        await m.query(
          `INSERT INTO supplier_orders(id,sku_id,supplier,reference,quantity,unit_cost_krw,expected_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            payload.skuId,
            payload.supplier,
            payload.reference,
            payload.quantity,
            payload.unitCostKRW,
            payload.expectedAt,
          ],
        );
        await this.ops.event(m, a.userId, 'OWNER', id, 'PROCUREMENT_CREATED', {
          skuId: payload.skuId,
          quantity: payload.quantity,
        });
        return { id, version: 1, status: 'PLANNED', received: 0 };
      },
    );
  }
  async changeProcurement(
    a: AuthenticatedUser,
    id: string,
    key: string,
    d: ProcurementChangeDto,
  ) {
    integer(d.expectedVersion, 1, 2147483646);
    const reason = plain(d.reason, 1, 200);
    if (
      d.confirmed !== true ||
      !['ORDERED', 'RECEIVE', 'CANCELLED'].includes(d.action)
    )
      throw fail('처리 내용을 확인해주세요', 400);
    if (d.action === 'RECEIVE') integer(d.quantity, 1, 100000);
    else if (d.quantity !== undefined)
      throw fail('입고 처리에만 수량을 입력해주세요', 400);
    return this.ops.perform(
      a,
      'OWNER',
      key,
      { op: 'procurement-change', id, ...d, reason },
      async (m) => {
        const [p] = await m.query(
          'SELECT * FROM supplier_orders WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (!p) throw fail('발주 기록을 찾을 수 없습니다', 404);
        if (p.version !== d.expectedVersion)
          throw fail('최신 발주 상태를 확인해주세요');
        let status = p.status,
          received = p.received;
        if (d.action === 'ORDERED') {
          if (status !== 'PLANNED')
            throw fail('발주 계획에서만 주문 완료를 기록할 수 있습니다');
          status = 'ORDERED';
        } else if (d.action === 'CANCELLED') {
          if (!['PLANNED', 'ORDERED'].includes(status) || received)
            throw fail('입고 전 발주만 취소할 수 있습니다');
          status = 'CANCELLED';
        } else {
          if (
            !['ORDERED', 'PARTIAL'].includes(status) ||
            received + d.quantity > p.quantity
          )
            throw fail('아직 입고되지 않은 수량만 처리할 수 있습니다');
          const [sku] = await m.query(
            'SELECT * FROM warehouse_skus WHERE id=$1 FOR UPDATE',
            [p.sku_id],
          );
          await move(
            m,
            sku,
            a.userId,
            'RECEIVE',
            'procurement:' + key,
            d.quantity,
            0,
            reason,
          );
          received += d.quantity;
          status = received === p.quantity ? 'RECEIVED' : 'PARTIAL';
        }
        await m.query(
          'UPDATE supplier_orders SET status=$2,received=$3,version=version+1,updated_at=now() WHERE id=$1',
          [id, status, received],
        );
        await this.ops.event(
          m,
          a.userId,
          'OWNER',
          id,
          'PROCUREMENT_' + d.action,
          { quantity: d.quantity ?? 0, received, reason },
        );
        return { id, status, received, version: p.version + 1 };
      },
    );
  }
  private campaign(d: CampaignDto) {
    if (d.homeVisible != null && typeof d.homeVisible !== 'boolean')
      throw fail('배너 노출 여부를 확인해주세요', 400);
    const startsAt = timestamp(d.startsAt),
      endsAt = timestamp(d.endsAt);
    if (
      Date.parse(endsAt) <= Date.parse(startsAt) ||
      Date.parse(endsAt) - Date.parse(startsAt) > 366 * 86400000
    )
      throw fail(
        '이벤트 종료는 시작 이후, 기간은 1년 이내로 입력해주세요',
        400,
      );
    if (
      !['SHOWCASE', 'NOTICE'].includes(d.kind) ||
      (d.kind === 'SHOWCASE') !== (d.gachaId != null)
    )
      throw fail(
        '기획전에는 박스를 연결하고 운영 안내에는 박스를 연결하지 않습니다',
        400,
      );
    return {
      title: plain(d.title, 2, 120),
      body: plain(d.body, 1, 3000),
      kind: d.kind,
      gachaId: d.gachaId == null ? null : integer(d.gachaId, 1),
      startsAt,
      endsAt,
      budgetKRW: integer(d.budgetKRW, 0, 100000000),
      imageUrl: image(d.imageUrl ?? null),
      homeVisible: d.homeVisible ?? false,
      sortOrder: integer(d.sortOrder ?? 50, 0, 999),
    };
  }
  async campaigns(a: AuthenticatedUser, q: OwnerPageDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      return this.page(
        m,
        campaignSelect + ' ORDER BY created_at DESC,id DESC',
        [],
        q,
      );
    });
  }
  async saveCampaign(
    a: AuthenticatedUser,
    id: string | null,
    key: string,
    d: CampaignDto | EditCampaignDto,
  ) {
    const c = this.campaign(d),
      version =
        'expectedVersion' in d
          ? integer(d.expectedVersion, 1, 2147483646)
          : null;
    if (id && !version) throw fail('현재 버전을 확인해주세요', 400);
    return this.ops.perform(
      a,
      'OWNER',
      key,
      { op: 'campaign-save', id, version, ...c },
      async (m) => {
        if (c.gachaId) {
          const [g] = await m.query('SELECT id FROM gachas WHERE id=$1', [
            c.gachaId,
          ]);
          if (!g) throw fail('연결할 박스를 찾을 수 없습니다', 404);
        }
        let next = 1;
        if (id) {
          const [old] = await m.query(
            'SELECT * FROM owner_campaigns WHERE id=$1 FOR UPDATE',
            [id],
          );
          if (!old) throw fail('이벤트를 찾을 수 없습니다', 404);
          if (
            old.version !== version ||
            !['DRAFT', 'PAUSED'].includes(old.status)
          )
            throw fail('최신 초안 또는 중지된 이벤트만 수정할 수 있습니다');
          next = version + 1;
          await m.query(
            `UPDATE owner_campaigns SET title=$2,body=$3,kind=$4,gacha_id=$5,starts_at=$6,ends_at=$7,budget_krw=$8,status='DRAFT',version=$9,updated_at=now() WHERE id=$1`,
            [
              id,
              c.title,
              c.body,
              c.kind,
              c.gachaId,
              c.startsAt,
              c.endsAt,
              c.budgetKRW,
              next,
            ],
          );
        } else {
          id = randomUUID();
          await m.query(
            `INSERT INTO owner_campaigns(id,title,body,kind,gacha_id,starts_at,ends_at,budget_krw) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              id,
              c.title,
              c.body,
              c.kind,
              c.gachaId,
              c.startsAt,
              c.endsAt,
              c.budgetKRW,
            ],
          );
        }
        await m.query(
          'UPDATE owner_campaigns SET image_url=$2,home_visible=$3,sort_order=$4 WHERE id=$1',
          [id, c.imageUrl, c.homeVisible, c.sortOrder],
        );
        await this.ops.event(m, a.userId, 'OWNER', id, 'CAMPAIGN_SAVED', {
          version: next,
        });
        return { id, version: next, status: 'DRAFT' };
      },
    );
  }
  async campaignState(
    a: AuthenticatedUser,
    id: string,
    key: string,
    d: CampaignStateDto,
  ) {
    integer(d.expectedVersion, 1, 2147483646);
    if (
      d.confirmed !== true ||
      !['PUBLISHED', 'PAUSED', 'ARCHIVED'].includes(d.status)
    )
      throw fail('공개 상태를 확인해주세요', 400);
    return this.ops.perform(
      a,
      'OWNER',
      key,
      { op: 'campaign-state', id, ...d },
      async (m) => {
        const [c] = await m.query(
          'SELECT * FROM owner_campaigns WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (!c) throw fail('이벤트를 찾을 수 없습니다', 404);
        const allowed = {
          DRAFT: ['PUBLISHED', 'ARCHIVED'],
          PUBLISHED: ['PAUSED', 'ARCHIVED'],
          PAUSED: ['PUBLISHED', 'ARCHIVED'],
          ARCHIVED: [],
        };
        if (
          c.version !== d.expectedVersion ||
          !allowed[c.status].includes(d.status)
        )
          throw fail('최신 이벤트 상태에서 가능한 변경만 적용할 수 있습니다');
        if (d.status === 'PUBLISHED') {
          if (new Date(c.ends_at).getTime() <= Date.now())
            throw fail('종료된 이벤트는 공개할 수 없습니다');
          if (c.gacha_id) {
            const [g] = await m.query('SELECT active FROM gachas WHERE id=$1', [
              c.gacha_id,
            ]);
            if (!g?.active)
              throw fail('판매 중인 박스만 기획전에 연결할 수 있습니다');
          }
        }
        await m.query(
          'UPDATE owner_campaigns SET status=$2,version=version+1,updated_at=now() WHERE id=$1',
          [id, d.status],
        );
        await this.ops.event(m, a.userId, 'OWNER', id, 'CAMPAIGN_' + d.status, {
          version: c.version + 1,
        });
        return { id, status: d.status, version: c.version + 1 };
      },
    );
  }
  async publicCampaigns() {
    // Public projection deliberately excludes budget, internal status and audit data.
    const items = await this.db.query(
      `SELECT c.id,c.title,c.body,c.kind,c.gacha_id AS "gachaId",c.starts_at AS "startsAt",c.ends_at AS "endsAt",c.image_url AS "imageUrl",c.home_visible AS "homeVisible",c.sort_order AS "sortOrder" FROM owner_campaigns c LEFT JOIN gachas g ON g.id=c.gacha_id WHERE c.status='PUBLISHED' AND c.starts_at<=now() AND c.ends_at>now() AND (c.gacha_id IS NULL OR g.active=true) ORDER BY c.sort_order,c.starts_at DESC,c.id DESC LIMIT 100`,
    );
    return {
      contract: 'CAMPAIGNS_V1',
      items,
      asOf: new Date().toISOString(),
      rewardAutomation: false,
    };
  }
  async pauseSales(a: AuthenticatedUser, key: string, d: PauseSalesDto) {
    if (d.confirmation !== '전체 신규 판매 중지')
      throw fail('전체 신규 판매 중지를 확인해주세요', 400);
    const reason = plain(d.reason, 2, 200);
    return this.ops.perform(
      a,
      'OWNER',
      key,
      { op: 'pause-sales', reason, confirmation: d.confirmation },
      async (m) => {
        const active = await m.query(
          'SELECT id FROM gachas WHERE active=true ORDER BY id FOR UPDATE',
        );
        const ids = active.map((x) => x.id);
        if (ids.length) {
          await m.query(
            'UPDATE gachas SET active=false WHERE id=ANY($1::integer[])',
            [ids],
          );
          await m.query(
            'UPDATE catalog_drafts SET version=version+1,updated_at=now() WHERE gacha_id=ANY($1::integer[])',
            [ids],
          );
        }
        await this.ops.event(m, a.userId, 'OWNER', 'all', 'SALES_PAUSED', {
          count: ids.length,
          reason,
        });
        return { pausedCount: ids.length, reason };
      },
    );
  }
  async finance(a: AuthenticatedUser, q: OwnerPageDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      return this.page(
        m,
        `SELECT id,'PAYMENT' AS kind,amount,currency,status,order_id AS "orderId",created_at AS "createdAt" FROM payment_intents WHERE status IN('UNKNOWN','CONFIRMING','APPROVED') UNION ALL SELECT id,'REFUND' AS kind,amount,currency,status,order_id AS "orderId",created_at AS "createdAt" FROM order_refunds WHERE status<>'SUCCEEDED' ORDER BY "createdAt",id`,
        [],
        q,
      );
    });
  }
  async orders(a: AuthenticatedUser, q: OwnerPageDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      return this.page(
        m,
        `SELECT o.id,o.title_snapshot AS title,o.quantity,o.refunded_quantity AS "refundedQuantity",o.total,o.currency,o.status,o.created_at AS "createdAt",(SELECT count(*)::int FROM owned_capsules c WHERE c.order_id=o.id AND c.status='OPENED') AS opened FROM capsule_orders o ORDER BY o.created_at DESC,o.id DESC`,
        [],
        q,
      );
    });
  }
  async audit(a: AuthenticatedUser, q: OwnerPageDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      return this.page(
        m,
        `SELECT id,actor_id AS "actorId",target_type AS "targetType",target_id AS "targetId",event,detail,created_at AS "createdAt" FROM operations_events ORDER BY id DESC`,
        [],
        q,
      );
    });
  }
}
