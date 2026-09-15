import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { validatePage } from './commerce.policy';
@Injectable()
export class HistoryService {
  constructor(private readonly db: DataSource) {}
  capabilities() {
    return { contract: 'TRANSACTION_HISTORY_V1', enabled: true };
  }
  async orders(u: number, page = 1, limit = 20) {
    validatePage(page, limit);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const [{ n }] = await m.query(
          'SELECT count(*) AS n FROM capsule_orders WHERE user_id=$1',
          [u],
        ),
        items = await m.query(
          `SELECT o.id AS "orderId",o.gacha_id AS "gachaId",o.title_snapshot AS title,o.quantity,o.total,o.currency,o.status,o.created_at AS "createdAt",o.refunded_quantity AS "refundedQuantity",o.refund_eligible AS "refundEligible",o.refund_until AS "refundUntil",(SELECT count(*)::integer FROM owned_capsules c WHERE c.order_id=o.id AND c.status='UNOPENED') AS "unopenedCount" FROM capsule_orders o WHERE o.user_id=$1 ORDER BY o.created_at DESC,o.id DESC OFFSET $2 LIMIT $3`,
          [u, (page - 1) * limit, limit],
        );
      return { items, totalCount: Number(n), page, limit };
    });
  }
  async openings(u: number, page = 1, limit = 20) {
    validatePage(page, limit);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const join =
          'FROM capsule_openings x JOIN owned_capsules c ON c.id=x.capsule_id JOIN capsule_orders o ON o.id=c.order_id WHERE o.user_id=$1',
        [{ n }] = await m.query('SELECT count(*) AS n ' + join, [u]),
        items = await m.query(
          'SELECT x.capsule_id AS "capsuleId",x.inventory_item_id AS "inventoryItemId",c.order_id AS "orderId",x.prize,x.opened_at AS "openedAt" ' +
            join +
            ' ORDER BY x.opened_at DESC,x.capsule_id DESC OFFSET $2 LIMIT $3',
          [u, (page - 1) * limit, limit],
        );
      return { items, totalCount: Number(n), page, limit };
    });
  }
}
