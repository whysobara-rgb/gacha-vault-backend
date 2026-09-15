import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  conversionError as fail,
  digest,
} from '../conversions/conversion.policy';
import {
  capsuleIds,
  requireRefund,
  validKey,
  validatePage,
  preview,
} from './commerce.policy';
import { lockUser } from './commerce.db';
import { DanalProvider } from './danal.provider';
export type RefundDto = {
  capsuleIds: string[];
  expectedAmount: number;
  reason: string;
};
@Injectable()
export class RefundsService {
  constructor(
    private readonly db: DataSource,
    private readonly provider: DanalProvider,
  ) {}
  capabilities() {
    return {
      contract: 'ORDER_REFUND_V1',
      enabled: preview() && process.env.ENABLE_ORDER_REFUND_PREVIEW === 'true',
      cashEnabled: this.provider.ready(),
      businessDays: 7,
    };
  }
  private async order(m: EntityManager, u: number, id: string) {
    const [o] = await m.query(
      'SELECT * FROM capsule_orders WHERE id=$1 AND user_id=$2',
      [id, u],
    );
    if (!o) throw fail('주문을 찾을 수 없습니다', 404);
    return o;
  }
  private async eligible(
    m: EntityManager,
    u: number,
    id: string,
    ids: string[],
    lock = false,
  ) {
    const o = await this.order(m, u, id);
    if (!o.refund_eligible || !o.refund_until)
      throw fail('구매 당시 환불 정책을 확인할 수 없거나 환불 대상이 아닙니다');
    if (!['PAID', 'PARTIALLY_REFUNDED'].includes(o.status))
      throw fail('환불 가능한 주문 상태가 아닙니다');
    if (
      (
        await m.query(
          "SELECT id FROM order_refunds WHERE order_id=$1 AND status<>'SUCCEEDED'",
          [id],
        )
      ).length
    )
      throw fail('이 주문의 환불 처리 결과를 먼저 확인해주세요');
    const [{ expired }] = await m.query(
      'SELECT clock_timestamp()>$1::timestamptz AS expired',
      [o.refund_until],
    );
    if (expired) throw fail('환불 가능 기간이 지났습니다');
    const rows = await m.query(
      `SELECT id,sequence,status FROM owned_capsules WHERE order_id=$1 AND id=ANY($2::uuid[]) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
      [id, ids],
    );
    if (rows.length !== ids.length)
      throw fail('이 주문의 캡슐을 선택해주세요', 404);
    if (rows.some((r) => r.status !== 'UNOPENED'))
      throw fail('미개봉 캡슐만 환불할 수 있습니다');
    return { o, rows, amount: o.unit_price * ids.length };
  }
  async quote(u: number, id: string, selected: string[]) {
    requireRefund();
    id = validKey(id);
    const ids = capsuleIds(selected);
    return this.db.transaction(async (m) => {
      const user = await lockUser(m, u),
        q = await this.eligible(m, u, id, ids);
      return {
        orderId: id,
        capsules: q.rows,
        quantity: ids.length,
        amount: q.amount,
        currency: q.o.currency,
        balance: Number(user.balance),
        refundUntil: q.o.refund_until,
        refundPolicy: q.o.refund_policy,
        cashEnabled: this.provider.ready(),
      };
    });
  }
  private async receipt(m: EntityManager, u: number, id: string) {
    const [r] = await m.query(
      'SELECT * FROM order_refunds WHERE id=$1 AND user_id=$2',
      [id, u],
    );
    if (!r) throw fail('환불 내역을 찾을 수 없습니다', 404);
    return {
      refundId: r.id,
      orderId: r.order_id,
      capsuleIds: r.capsule_ids,
      quantity: r.capsule_ids.length,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      balanceAfter: r.balance_after === null ? null : Number(r.balance_after),
      createdAt: r.created_at,
      completedAt: r.completed_at,
      reason: r.reason,
    };
  }
  private async finish(m: EntityManager, u: number, id: string) {
    const user = await lockUser(m, u),
      r = await this.receipt(m, u, id);
    if (r.status === 'SUCCEEDED') return r;
    if (r.status !== 'APPROVED') throw fail('환불 승인 결과가 필요합니다');
    const o = await this.order(m, u, r.orderId);
    await m.query('SELECT id FROM gachas WHERE id=$1 FOR UPDATE', [o.gacha_id]);
    const rows = await m.query(
      'SELECT id,status FROM owned_capsules WHERE order_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [o.id, r.capsuleIds],
    );
    if (
      rows.length !== r.quantity ||
      rows.some((c) => c.status !== 'REFUND_PENDING')
    )
      throw fail('환불 캡슐 상태를 확인해주세요');
    let walletId = null,
      balance = BigInt(user.balance);
    if (r.currency === 'GP') {
      balance += BigInt(r.amount);
      if (balance > BigInt(Number.MAX_SAFE_INTEGER))
        throw fail('잔액 한도를 확인해주세요');
      await m.query('UPDATE users SET "coinBalance"=$1 WHERE id=$2', [
        balance.toString(),
        u,
      ]);
      const [w] = await m.query(
        `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",origin,description) VALUES($1,'EARN',$2,$3,'CAPSULE_REFUND',$4) RETURNING id`,
        [u, r.amount, balance.toString(), '미개봉 캡슐 환불 ' + id],
      );
      walletId = w.id;
    }
    await m.query(
      "UPDATE owned_capsules SET status='REFUNDED' WHERE order_id=$1 AND id=ANY($2::uuid[])",
      [o.id, r.capsuleIds],
    );
    await m.query(
      "UPDATE capsule_orders SET refunded_quantity=refunded_quantity+$1,status=CASE WHEN refunded_quantity+$1=quantity THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END WHERE id=$2",
      [r.quantity, o.id],
    );
    await m.query(
      "UPDATE order_refunds SET status='SUCCEEDED',wallet_transaction_id=$1,balance_after=$2,completed_at=clock_timestamp() WHERE id=$3",
      [walletId, r.currency === 'GP' ? balance.toString() : null, id],
    );
    return this.receipt(m, u, id);
  }
  async refund(u: number, orderId: string, key: string, dto: RefundDto) {
    requireRefund();
    orderId = validKey(orderId);
    key = validKey(key);
    const ids = capsuleIds(dto.capsuleIds),
      reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
    if (
      !reason ||
      reason.length > 255 ||
      /[\u0000-\u001f]/.test(reason) ||
      !Number.isInteger(dto.expectedAmount) ||
      dto.expectedAmount < 1
    )
      throw fail('환불 금액과 사유를 확인해주세요', 400);
    const hash = digest({ orderId, ids, amount: dto.expectedAmount, reason });
    const initial = await this.db.transaction(async (m) => {
      await lockUser(m, u);
      const [old] = await m.query(
        'SELECT * FROM order_refunds WHERE user_id=$1 AND idempotency_key=$2',
        [u, key],
      );
      if (old) {
        if (old.request_hash !== hash)
          throw fail('같은 요청 번호를 다른 환불에 사용할 수 없습니다');
        if (old.status === 'APPROVED')
          return { result: await this.finish(m, u, old.id) };
        return { result: await this.receipt(m, u, old.id) };
      }
      const q = await this.eligible(m, u, orderId, ids, true);
      if (q.amount !== dto.expectedAmount)
        throw fail('환불 금액을 다시 확인해주세요');
      let payment: any = null;
      if (q.o.currency === 'KRW') {
        if (!this.provider.ready())
          throw fail('카드 취소 설정이 필요합니다', 503);
        [payment] = await m.query(
          "SELECT * FROM payment_intents WHERE order_id=$1 AND user_id=$2 AND status='PAID'",
          [orderId, u],
        );
        if (
          !payment ||
          !payment.transaction_id ||
          payment.merchant_id !== this.provider.config().merchantId
        )
          throw fail('원결제 정보를 확인해주세요');
      }
      const id = randomUUID();
      await m.query(
        `INSERT INTO order_refunds(id,user_id,order_id,idempotency_key,request_hash,capsule_ids,amount,currency,status,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          u,
          orderId,
          key,
          hash,
          ids,
          q.amount,
          q.o.currency,
          q.o.currency === 'GP' ? 'APPROVED' : 'PROCESSING',
          reason,
        ],
      );
      await m.query(
        "UPDATE owned_capsules SET status='REFUND_PENDING' WHERE order_id=$1 AND id=ANY($2::uuid[])",
        [orderId, ids],
      );
      if (q.o.currency === 'GP') return { result: await this.finish(m, u, id) };
      return {
        dispatch: {
          id,
          payment,
          amount: q.amount,
          partial: q.amount !== q.o.total || q.o.refunded_quantity > 0,
        },
      };
    });
    if (initial.result) return initial.result;
    const d = initial.dispatch!,
      outcome = await this.provider.cancel({
        transactionId: d.payment.transaction_id,
        merchantId: d.payment.merchant_id,
        amount: d.amount,
        partial: d.partial,
        reason,
      });
    await this.db.transaction(async (m) => {
      await lockUser(m, u);
      await m.query(
        "UPDATE order_refunds SET status=$1,provider_cancel_id=$2 WHERE id=$3 AND status='PROCESSING'",
        [
          outcome.confirmed ? 'APPROVED' : 'UNKNOWN',
          outcome.confirmed ? outcome.transactionId : null,
          d.id,
        ],
      );
    });
    return outcome.confirmed
      ? this.db.transaction((m) => this.finish(m, u, d.id))
      : this.findOne(u, d.id);
  }
  async findOne(u: number, id: string) {
    id = validKey(id);
    return this.db.transaction('REPEATABLE READ', (m) =>
      this.receipt(m, u, id),
    );
  }
  async byRequest(u: number, key: string) {
    key = validKey(key);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const [r] = await m.query(
        'SELECT id FROM order_refunds WHERE user_id=$1 AND idempotency_key=$2',
        [u, key],
      );
      if (!r) throw fail('확인된 환불이 없습니다', 404);
      return this.receipt(m, u, r.id);
    });
  }
  async list(u: number, page = 1, limit = 20) {
    validatePage(page, limit);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const [{ n }] = await m.query(
          'SELECT count(*) AS n FROM order_refunds WHERE user_id=$1',
          [u],
        ),
        rows = await m.query(
          'SELECT id FROM order_refunds WHERE user_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT $3',
          [u, (page - 1) * limit, limit],
        ),
        items = [];
      for (const r of rows) items.push(await this.receipt(m, u, r.id));
      return { items, totalCount: Number(n), page, limit };
    });
  }
}
