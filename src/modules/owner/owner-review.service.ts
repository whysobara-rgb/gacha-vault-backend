import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { OperationsService } from '../operations/operations.service';
import { plain } from '../account-support/account-support.policy';
import { fail, integer } from '../operations/operations.policy';
import { validKey } from '../conversions/conversion.policy';
import {
  CaseListDto,
  ChangeCaseDto,
  CreateCaseDto,
  TraceLookupDto,
} from './owner-review.dto';
import { OwnerPageDto } from './owner.dto';
const caseFields = `c.id,c.order_id AS "orderId",c.ticket_id AS "ticketId",c.kind,c.status,c.summary,c.internal_note AS "internalNote",c.external_reference AS "externalReference",c.version,c.created_at AS "createdAt",c.updated_at AS "updatedAt"`;
@Injectable()
export class OwnerReviewService {
  constructor(
    private readonly db: DataSource,
    private readonly ops: OperationsService,
  ) {}
  private async access(m: EntityManager, a: AuthenticatedUser) {
    await this.ops.access(m, a, 'OWNER');
  }
  async lookup(a: AuthenticatedUser, q: TraceLookupDto) {
    const reference =
      q.kind === 'inventory'
        ? String(integer(Number(q.reference), 1))
        : validKey(q.reference);
    const relations = {
      order: 'SELECT id AS order_id FROM capsule_orders WHERE id=$1',
      inventory:
        'SELECT c.order_id FROM capsule_openings x JOIN owned_capsules c ON c.id=x.capsule_id WHERE x.inventory_item_id=$1',
      shipment:
        'SELECT DISTINCT c.order_id FROM fulfillment_order_items f JOIN capsule_openings x ON x.inventory_item_id=f.inventory_item_id JOIN owned_capsules c ON c.id=x.capsule_id WHERE f.fulfillment_id=$1',
      payment:
        'SELECT order_id FROM payment_intents WHERE id=$1 AND order_id IS NOT NULL',
      refund: 'SELECT order_id FROM order_refunds WHERE id=$1',
      conversion:
        'SELECT DISTINCT c.order_id FROM inventory_conversion_items i JOIN capsule_openings x ON x.inventory_item_id=i.inventory_item_id JOIN owned_capsules c ON c.id=x.capsule_id WHERE i.conversion_id=$1',
      ticket:
        'SELECT order_id FROM support_tickets WHERE id=$1 AND order_id IS NOT NULL',
    };
    if (!relations[q.kind]) throw fail('추적 대상 종류를 확인해주세요', 400);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      const orders = await m.query(
        `SELECT o.id,o.title_snapshot AS title,o.status,o.total,o.currency,o.created_at AS "createdAt" FROM capsule_orders o WHERE id IN(${relations[q.kind]}) ORDER BY o.created_at DESC,o.id LIMIT 100`,
        [reference],
      );
      return { contract: 'OWNER_TRACE_V1', reference, kind: q.kind, orders };
    });
  }
  async order(a: AuthenticatedUser, id: string) {
    id = validKey(id);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      const [order] = await m.query(
        `SELECT o.id,o.user_id AS "userId",u.nickname,o.gacha_id AS "gachaId",o.title_snapshot AS title,o.unit_price AS "unitPrice",o.quantity,o.total,o.currency,o.status,o.refunded_quantity AS "refundedQuantity",o.probability_version AS "probabilityVersion",o.probability_snapshot AS "probabilitySnapshot",o.refund_policy AS "refundPolicy",o.wallet_transaction_id AS "walletTransactionId",o.created_at AS "createdAt" FROM capsule_orders o JOIN users u ON u.id=o.user_id WHERE o.id=$1`,
        [id],
      );
      if (!order) throw fail('주문을 찾을 수 없습니다', 404);
      const capsules = await m.query(
        `SELECT c.id,c.sequence,c.status,x.inventory_item_id AS "inventoryItemId",x.prize,x.opened_at AS "openedAt",i.status AS "inventoryStatus",i."isLocked",i.item_id AS "itemId",p.warehouse_sku_id AS "skuId" FROM owned_capsules c LEFT JOIN capsule_openings x ON x.capsule_id=c.id LEFT JOIN inventory_items i ON i.id=x.inventory_item_id LEFT JOIN items p ON p.id=i.item_id WHERE c.order_id=$1 ORDER BY c.sequence`,
        [id],
      );
      const itemIds = capsules.flatMap((c) =>
        c.inventoryItemId ? [c.inventoryItemId] : [],
      );
      const shipments = await m.query(
        `SELECT f.id,f.status,f.carrier,f.tracking_number AS "trackingNumber",f.fee_gp AS "feeGP",f.created_at AS "createdAt",array_agg(i.inventory_item_id ORDER BY i.inventory_item_id) AS "inventoryItemIds" FROM fulfillment_orders f JOIN fulfillment_order_items i ON i.fulfillment_id=f.id WHERE i.inventory_item_id=ANY($1::integer[]) GROUP BY f.id ORDER BY f.created_at,f.id LIMIT 201`,
        [itemIds],
      );
      const conversions = await m.query(
        `SELECT c.id,c.status,c.total_gp AS "totalGP",c.wallet_transaction_id AS "walletTransactionId",c.restore_wallet_transaction_id AS "restoreWalletTransactionId",c.created_at AS "createdAt",c.restored_at AS "restoredAt",array_agg(i.inventory_item_id ORDER BY i.inventory_item_id) AS "inventoryItemIds" FROM inventory_conversions c JOIN inventory_conversion_items i ON i.conversion_id=c.id WHERE i.inventory_item_id=ANY($1::integer[]) GROUP BY c.id ORDER BY c.created_at,c.id LIMIT 201`,
        [itemIds],
      );
      const payments = await m.query(
        `SELECT id,status,amount,currency,transaction_id AS "providerTransactionId",created_at AS "createdAt" FROM payment_intents WHERE order_id=$1 ORDER BY created_at,id`,
        [id],
      );
      const refunds = await m.query(
        `SELECT id,status,amount,currency,capsule_ids AS "capsuleIds",wallet_transaction_id AS "walletTransactionId",reason,created_at AS "createdAt",completed_at AS "completedAt" FROM order_refunds WHERE order_id=$1 ORDER BY created_at,id LIMIT 201`,
        [id],
      );
      const tickets = await m.query(
        `SELECT id,subject,status,version,created_at AS "createdAt",updated_at AS "updatedAt" FROM support_tickets WHERE order_id=$1 ORDER BY created_at,id LIMIT 201`,
        [id],
      );
      const cases = await m.query(
        `SELECT ${caseFields} FROM owner_cases c WHERE order_id=$1 ORDER BY created_at,id LIMIT 201`,
        [id],
      );
      const audit = await m.query(
        `SELECT id,actor_id AS "actorId",target_type AS "targetType",target_id AS "targetId",event,detail,created_at AS "createdAt" FROM operations_events WHERE (target_type='CATALOG' AND target_id=$1) OR (target_type='FULFILLMENT' AND target_id=ANY($2::text[])) OR (target_type='OWNER' AND target_id=ANY($3::text[])) ORDER BY id DESC LIMIT 201`,
        [
          String(order.gachaId),
          shipments.map((x) => x.id),
          cases.map((x) => x.id),
        ],
      );
      const sections = {
        shipments,
        conversions,
        refunds,
        tickets,
        cases,
        audit,
      };
      const truncated = Object.entries(sections)
        .filter(([, x]) => x.length > 200)
        .map(([key]) => key);
      return {
        contract: 'OWNER_ORDER_TRACE_V1',
        asOf: new Date().toISOString(),
        order,
        capsules,
        payments,
        shipments: shipments.slice(0, 200),
        conversions: conversions.slice(0, 200),
        refunds: refunds.slice(0, 200),
        tickets: tickets.slice(0, 200),
        cases: cases.slice(0, 200),
        audit: audit.slice(0, 200),
        truncated,
        scope: 'DIRECT_ORDER_RELATIONS',
        relatedTotalsMaySpanOrders: true,
      };
    });
  }
  async cases(a: AuthenticatedUser, q: CaseListDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      integer(q.page, 1, 100000);
      integer(q.limit, 1, 100);
      const status = q.status ?? null;
      const [{ n }] = await m.query(
        'SELECT count(*)::int AS n FROM owner_cases WHERE ($1::text IS NULL OR status=$1)',
        [status],
      );
      const items = await m.query(
        `SELECT ${caseFields},o.title_snapshot AS "orderTitle" FROM owner_cases c JOIN capsule_orders o ON o.id=c.order_id WHERE ($1::text IS NULL OR c.status=$1) ORDER BY CASE WHEN c.status='CLOSED' THEN 1 ELSE 0 END,c.updated_at,c.id LIMIT $2 OFFSET $3`,
        [status, q.limit, (q.page - 1) * q.limit],
      );
      return {
        items,
        totalCount: n,
        page: q.page,
        limit: q.limit,
        externalActionsAutomatic: false,
      };
    });
  }
  async case(a: AuthenticatedUser, id: string) {
    id = validKey(id);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.access(m, a);
      const [c] = await m.query(
        `SELECT ${caseFields} FROM owner_cases c WHERE id=$1`,
        [id],
      );
      if (!c) throw fail('조치 기록을 찾을 수 없습니다', 404);
      const events = await m.query(
        'SELECT id,event,detail,created_at AS "createdAt" FROM operations_events WHERE target_type=\'OWNER\' AND target_id=$1 ORDER BY id DESC LIMIT 201',
        [id],
      );
      return {
        ...c,
        events: events.slice(0, 200),
        eventsTruncated: events.length > 200,
      };
    });
  }
  private notes(d: CreateCaseDto | ChangeCaseDto) {
    return {
      summary: plain(d.summary, 2, 1000),
      internalNote: plain(d.internalNote, 0, 2000, true),
      externalReference: plain(d.externalReference, 0, 200, true),
    };
  }
  async createCase(a: AuthenticatedUser, key: string, d: CreateCaseDto) {
    const orderId = validKey(d.orderId),
      ticketId = d.ticketId ? validKey(d.ticketId) : null,
      notes = this.notes(d);
    if (!['RETURN', 'EXCHANGE', 'MISSING', 'DAMAGE', 'OTHER'].includes(d.kind))
      throw fail('조치 종류를 확인해주세요', 400);
    return this.ops.perform(
      a,
      'OWNER',
      key,
      { op: 'case-create', orderId, ticketId, kind: d.kind, ...notes },
      async (m) => {
        const [o] = await m.query(
          'SELECT user_id FROM capsule_orders WHERE id=$1',
          [orderId],
        );
        if (!o) throw fail('주문을 찾을 수 없습니다', 404);
        if (ticketId) {
          const [t] = await m.query(
            'SELECT user_id,order_id FROM support_tickets WHERE id=$1',
            [ticketId],
          );
          if (!t || t.user_id !== o.user_id || t.order_id !== orderId)
            throw fail('같은 고객 주문에 연결된 문의만 선택해주세요', 400);
        }
        const id = randomUUID();
        await m.query(
          "INSERT INTO owner_cases(id,order_id,ticket_id,kind,status,summary,internal_note,external_reference) VALUES($1,$2,$3,$4,'OPEN',$5,$6,$7)",
          [
            id,
            orderId,
            ticketId,
            d.kind,
            notes.summary,
            notes.internalNote,
            notes.externalReference,
          ],
        );
        await this.ops.event(m, a.userId, 'OWNER', id, 'CASE_CREATED', {
          orderId,
          ticketId,
          kind: d.kind,
          ...notes,
        });
        return { id, version: 1, status: 'OPEN' };
      },
    );
  }
  async changeCase(
    a: AuthenticatedUser,
    id: string,
    key: string,
    d: ChangeCaseDto,
  ) {
    id = validKey(id);
    integer(d.expectedVersion, 1, 2147483646);
    const notes = this.notes(d),
      reason = plain(d.reason, 2, 200);
    if (
      !['OPEN', 'IN_PROGRESS', 'WAITING_EXTERNAL', 'CLOSED'].includes(d.status)
    )
      throw fail('조치 상태를 확인해주세요', 400);
    return this.ops.perform(
      a,
      'OWNER',
      key,
      { op: 'case-change', id, ...d, ...notes, reason },
      async (m) => {
        const [c] = await m.query(
          'SELECT * FROM owner_cases WHERE id=$1 FOR UPDATE',
          [id],
        );
        if (!c) throw fail('조치 기록을 찾을 수 없습니다', 404);
        if (c.version !== d.expectedVersion)
          throw fail('최신 조치 기록을 확인해주세요');
        if (c.status === 'CLOSED' && d.status !== 'OPEN')
          throw fail('종료 기록은 먼저 다시 열어주세요');
        if (
          d.status === 'CLOSED' &&
          (!notes.internalNote || !notes.externalReference)
        )
          throw fail('종료 전 실제 처리 근거와 참조번호를 남겨주세요', 400);
        await m.query(
          'UPDATE owner_cases SET status=$2,summary=$3,internal_note=$4,external_reference=$5,version=version+1,updated_at=now() WHERE id=$1',
          [
            id,
            d.status,
            notes.summary,
            notes.internalNote,
            notes.externalReference,
          ],
        );
        await this.ops.event(m, a.userId, 'OWNER', id, 'CASE_UPDATED', {
          orderId: c.order_id,
          beforeStatus: c.status,
          status: d.status,
          reason,
          ...notes,
        });
        return { id, version: c.version + 1, status: d.status };
      },
    );
  }
  async customerCases(a: AuthenticatedUser, q: OwnerPageDto) {
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const [u] = await m.query('SELECT auth_version FROM users WHERE id=$1', [
        a.userId,
      ]);
      if (!u || u.auth_version !== (a.authVersion ?? 0))
        throw fail('다시 로그인해주세요', 401);
      integer(q.page, 1, 100000);
      integer(q.limit, 1, 100);
      const [{ n }] = await m.query(
        'SELECT count(*)::int AS n FROM owner_cases c JOIN capsule_orders o ON o.id=c.order_id WHERE o.user_id=$1',
        [a.userId],
      );
      return {
        items: await m.query(
          'SELECT c.id,c.order_id AS "orderId",c.kind,c.status,c.summary,c.updated_at AS "updatedAt" FROM owner_cases c JOIN capsule_orders o ON o.id=c.order_id WHERE o.user_id=$1 ORDER BY c.updated_at DESC,c.id LIMIT $2 OFFSET $3',
          [a.userId, q.limit, (q.page - 1) * q.limit],
        ),
        totalCount: n,
        page: q.page,
        limit: q.limit,
      };
    });
  }
}
