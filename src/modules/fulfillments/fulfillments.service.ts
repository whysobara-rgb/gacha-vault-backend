import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  conversionError as fail,
  digest,
  validKey,
} from '../conversions/conversion.policy';
import {
  quoteInput,
  rateTable,
  requireShipping,
  shippingEnabled,
  zoneFor,
} from './fulfillment.policy';
import { FulfillmentQuoteDto } from './fulfillment.dto';
const CANCELLABLE = ['REQUESTED', 'PREPARING'];
@Injectable()
export class FulfillmentsService {
  constructor(private readonly db: DataSource) {}
  capabilities() {
    let rates = null;
    try {
      rates = rateTable();
    } catch {}
    return {
      contract: 'FULFILLMENT_V1',
      enabled: shippingEnabled() && !!rates,
      quoteMinutes: 10,
      country: 'KR',
      rates,
    };
  }
  private async user(m: EntityManager, id: number, lock = true) {
    if (!Number.isSafeInteger(id) || id < 1)
      throw fail('계정을 확인해주세요', 400);
    const [u] = await m.query(
      `SELECT id,"coinBalance" AS balance FROM users WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!u) throw fail('계정을 찾을 수 없습니다', 404);
    if (
      BigInt(u.balance) < 0n ||
      BigInt(u.balance) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw fail('잔액 확인이 필요합니다');
    return u;
  }
  private async inventory(
    m: EntityManager,
    userId: number,
    ids: number[],
    lock: boolean,
  ) {
    const rows = await m.query(
      `SELECT i.id AS "inventoryItemId",i.status,i."isLocked",o.prize,p.fulfillment_type,p.shipping_enabled FROM inventory_items i JOIN items p ON p.id=i.item_id LEFT JOIN capsule_openings o ON o.inventory_item_id=i.id WHERE i.user_id=$1 AND i.id=ANY($2::integer[]) ORDER BY i.id ${lock ? 'FOR UPDATE OF i FOR SHARE OF p' : ''}`,
      [userId, ids],
    );
    if (rows.length !== ids.length)
      throw fail('선택한 상품을 찾을 수 없습니다', 404);
    for (const r of rows) {
      if (r.status !== 'STORED')
        throw fail('보관중인 상품만 배송할 수 있습니다');
      if (!r.shipping_enabled || r.fulfillment_type !== 'PHYSICAL' || !r.prize)
        throw fail('배송 가능 여부가 확인된 실물 상품만 신청할 수 있습니다');
    }
    return rows.map((r) => ({
      inventoryItemId: r.inventoryItemId,
      prize: r.prize,
      previousLock: r.isLocked,
    }));
  }
  async quote(userId: number, dto: FulfillmentQuoteDto) {
    requireShipping();
    const input = quoteInput(dto),
      rates = rateTable(),
      zone = zoneFor(input.recipient.postalCode, rates);
    return this.db.transaction(async (m) => {
      const u = await this.user(m, userId),
        items = await this.inventory(m, userId, input.inventoryItemIds, false);
      await m.query(
        `DELETE FROM fulfillment_quotes q WHERE user_id=$1 AND expires_at<clock_timestamp() AND NOT EXISTS (SELECT 1 FROM fulfillment_orders f WHERE f.quote_id=q.id)`,
        [userId],
      );
      const [{ n }] = await m.query(
        `SELECT count(*) AS n FROM fulfillment_quotes q WHERE user_id=$1 AND NOT EXISTS(SELECT 1 FROM fulfillment_orders f WHERE f.quote_id=q.id)`,
        [userId],
      );
      if (Number(n) >= 20)
        throw fail(
          '진행 중인 배송 견적이 많습니다. 잠시 후 다시 확인해주세요',
          429,
        );
      const id = randomUUID();
      await m.query(
        `INSERT INTO fulfillment_quotes(id,user_id,inventory_item_ids,recipient,items,fee_gp,rate_version,zone,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes')`,
        [
          id,
          userId,
          input.inventoryItemIds,
          JSON.stringify(input.recipient),
          JSON.stringify(items),
          zone.feeGP,
          digest(rates),
          JSON.stringify(zone),
        ],
      );
      const [q] = await m.query(
        'SELECT expires_at FROM fulfillment_quotes WHERE id=$1',
        [id],
      );
      return {
        quoteId: id,
        recipient: input.recipient,
        items,
        feeGP: zone.feeGP,
        zone,
        expiresAt: q.expires_at,
        balance: Number(u.balance),
      };
    });
  }
  async getQuote(userId: number, id: string) {
    id = validKey(id);
    return this.db.transaction(async (m) => {
      const u = await this.user(m, userId, false),
        [q] = await m.query(
          'SELECT * FROM fulfillment_quotes WHERE id=$1 AND user_id=$2',
          [id, userId],
        );
      if (!q) throw fail('배송 견적을 찾을 수 없습니다', 404);
      return {
        quoteId: q.id,
        recipient: q.recipient,
        items: q.items,
        feeGP: q.fee_gp,
        zone: q.zone,
        expiresAt: q.expires_at,
        balance: Number(u.balance),
      };
    });
  }
  private async receipt(m: EntityManager, userId: number, id: string) {
    const [r] = await m.query(
      'SELECT * FROM fulfillment_orders WHERE id=$1 AND user_id=$2',
      [id, userId],
    );
    if (!r) throw fail('배송 신청을 찾을 수 없습니다', 404);
    const items = await m.query(
      `SELECT inventory_item_id AS "inventoryItemId",prize FROM fulfillment_order_items WHERE fulfillment_id=$1 ORDER BY inventory_item_id`,
      [id],
    );
    return {
      fulfillmentId: r.id,
      status: r.status,
      recipient: r.recipient,
      feeGP: r.fee_gp,
      zone: r.zone,
      items,
      balanceAfter: Number(r.balance_after),
      cancelledBalanceAfter:
        r.cancelled_balance_after === null
          ? null
          : Number(r.cancelled_balance_after),
      createdAt: r.created_at,
      cancelledAt: r.cancelled_at,
      canCancel: CANCELLABLE.includes(r.status),
    };
  }
  async create(userId: number, key: string, quoteId: string) {
    requireShipping();
    key = validKey(key);
    quoteId = validKey(quoteId);
    return this.db.transaction(async (m) => {
      const u = await this.user(m, userId),
        [old] = await m.query(
          'SELECT id,quote_id FROM fulfillment_orders WHERE user_id=$1 AND idempotency_key=$2',
          [userId, key],
        );
      if (old) {
        if (old.quote_id !== quoteId)
          throw fail('같은 요청 번호를 다른 배송에 사용할 수 없습니다');
        return this.receipt(m, userId, old.id);
      }
      const [q] = await m.query(
        'SELECT * FROM fulfillment_quotes WHERE id=$1 AND user_id=$2',
        [quoteId, userId],
      );
      if (!q) throw fail('배송 견적을 찾을 수 없습니다', 404);
      if (
        (
          await m.query('SELECT id FROM fulfillment_orders WHERE quote_id=$1', [
            quoteId,
          ])
        ).length
      )
        throw fail('이미 신청에 사용된 견적입니다. 배송 내역을 확인해주세요');
      const items = await this.inventory(m, userId, q.inventory_item_ids, true),
        rates = rateTable();
      if (
        q.rate_version !== digest(rates) ||
        q.fee_gp !== zoneFor(q.recipient.postalCode, rates).feeGP
      )
        throw fail('배송비 정책이 변경되었습니다. 견적을 다시 확인해주세요');
      const [{ expired }] = await m.query(
        'SELECT clock_timestamp()>=$1::timestamptz AS expired',
        [q.expires_at],
      );
      if (expired) throw fail('배송 견적이 만료되었습니다. 다시 확인해주세요');
      const balance = BigInt(u.balance) - BigInt(q.fee_gp);
      if (balance < 0n) throw fail('배송비를 결제할 GP가 부족합니다');
      const id = randomUUID();
      await m.query('UPDATE users SET "coinBalance"=$1 WHERE id=$2', [
        balance.toString(),
        userId,
      ]);
      const [tx] = await m.query(
        `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",origin,description) VALUES($1,'USE',$2,$3,'SHIPPING_FEE',$4) RETURNING id`,
        [userId, -q.fee_gp, balance.toString(), `배송비 ${id}`],
      );
      await m.query(
        `INSERT INTO fulfillment_orders(id,user_id,idempotency_key,quote_id,recipient,fee_gp,zone,status,wallet_transaction_id,balance_after) VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED',$8,$9)`,
        [
          id,
          userId,
          key,
          quoteId,
          JSON.stringify(q.recipient),
          q.fee_gp,
          JSON.stringify(q.zone),
          tx.id,
          balance.toString(),
        ],
      );
      for (const i of items)
        await m.query(
          `INSERT INTO fulfillment_order_items(fulfillment_id,inventory_item_id,prize,previous_lock) VALUES($1,$2,$3,$4)`,
          [id, i.inventoryItemId, JSON.stringify(i.prize), i.previousLock],
        );
      await m.query(
        "UPDATE inventory_items SET status='SHIPPING_REQUESTED' WHERE id=ANY($1::integer[])",
        [q.inventory_item_ids],
      );
      return this.receipt(m, userId, id);
    });
  }
  async cancel(userId: number, id: string) {
    requireShipping();
    id = validKey(id);
    return this.db.transaction(async (m) => {
      const u = await this.user(m, userId),
        [locked] = await m.query(
          'SELECT id FROM fulfillment_orders WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [id, userId],
        );
      if (!locked) throw fail('배송 신청을 찾을 수 없습니다', 404);
      const r = await this.receipt(m, userId, id);
      if (r.status === 'CANCELLED') return r;
      if (!r.canCancel) throw fail('상품 준비중인 배송만 취소할 수 있습니다');
      const ids = r.items.map((i) => i.inventoryItemId),
        rows = await m.query(
          'SELECT id,status FROM inventory_items WHERE user_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR UPDATE',
          [userId, ids],
        );
      if (
        rows.length !== ids.length ||
        rows.some((i) => i.status !== 'SHIPPING_REQUESTED')
      )
        throw fail('상품 배송 상태가 변경되었습니다. 배송 내역을 확인해주세요');
      const balance = BigInt(u.balance) + BigInt(r.feeGP);
      if (balance > BigInt(Number.MAX_SAFE_INTEGER))
        throw fail('잔액 한도를 확인해주세요');
      await m.query('UPDATE users SET "coinBalance"=$1 WHERE id=$2', [
        balance.toString(),
        userId,
      ]);
      const [tx] = await m.query(
        `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",origin,description) VALUES($1,'EARN',$2,$3,'SHIPPING_REFUND',$4) RETURNING id`,
        [userId, r.feeGP, balance.toString(), `배송 취소 환급 ${id}`],
      );
      await m.query(
        `UPDATE inventory_items i SET status='STORED',"isLocked"=x.previous_lock FROM fulfillment_order_items x WHERE x.fulfillment_id=$1 AND x.inventory_item_id=i.id`,
        [id],
      );
      await m.query(
        'UPDATE fulfillment_order_items SET active=false WHERE fulfillment_id=$1',
        [id],
      );
      await m.query(
        "UPDATE fulfillment_orders SET status='CANCELLED',cancel_wallet_transaction_id=$1,cancelled_balance_after=$2,cancelled_at=clock_timestamp() WHERE id=$3",
        [tx.id, balance.toString(), id],
      );
      return this.receipt(m, userId, id);
    });
  }
  async findOne(userId: number, id: string) {
    id = validKey(id);
    return this.db.transaction('REPEATABLE READ', (m) =>
      this.receipt(m, userId, id),
    );
  }
  async byRequest(userId: number, key: string) {
    key = validKey(key);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const [r] = await m.query(
        'SELECT id FROM fulfillment_orders WHERE user_id=$1 AND idempotency_key=$2',
        [userId, key],
      );
      if (!r) throw fail('확인된 배송 신청이 없습니다', 404);
      return this.receipt(m, userId, r.id);
    });
  }
  async list(userId: number, page = 1, limit = 20) {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw fail('페이지를 확인해주세요', 400);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      await this.user(m, userId, false);
      const [{ n }] = await m.query(
        'SELECT count(*) AS n FROM fulfillment_orders WHERE user_id=$1',
        [userId],
      );
      const rows = await m.query(
        'SELECT id FROM fulfillment_orders WHERE user_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT $3',
        [userId, (page - 1) * limit, limit],
      );
      const items = [];
      for (const r of rows) items.push(await this.receipt(m, userId, r.id));
      return { items, totalCount: Number(n), page, limit };
    });
  }
}
