import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { conversionError as fail } from '../conversions/conversion.policy';
import { CreateGpOrderDto } from '../orders/order.dto';
import { loadProbability } from '../orders/probability';
import { DanalProvider } from './danal.provider';
import {
  refundCalendar,
  refundTerms,
  validKey,
  validatePage,
} from './commerce.policy';
import { lockUser, reservedStockSql } from './commerce.db';
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DataSource,
    private readonly provider: DanalProvider,
  ) {}
  capabilities() {
    return {
      contract: 'PAYMENT_V1',
      enabled: this.provider.ready(),
      methods: ['CARD'],
      productionEnabled: false,
    };
  }
  private require() {
    if (!this.provider.ready())
      throw fail('다날 테스트 결제 설정이 필요합니다', 503);
  }
  private async row(m: EntityManager, u: number, id: string) {
    const [r] = await m.query(
      'SELECT * FROM payment_intents WHERE id=$1 AND user_id=$2',
      [id, u],
    );
    if (!r) throw fail('결제 요청을 찾을 수 없습니다', 404);
    return r;
  }
  private present(r: any) {
    return {
      paymentId: r.id,
      orderId: r.order_id,
      gachaId: r.gacha_id,
      title: r.title,
      quantity: r.quantity,
      unitPrice: r.unit_price,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      method: r.method,
    };
  }
  async prepare(u: number, key: string, dto: CreateGpOrderDto) {
    this.require();
    key = validKey(key);
    if (
      !Number.isInteger(dto.quantity) ||
      dto.quantity < 1 ||
      dto.quantity > 100 ||
      !Number.isInteger(dto.gachaId) ||
      dto.gachaId < 1 ||
      !Number.isInteger(dto.expectedUnitPrice) ||
      dto.expectedUnitPrice < 100 ||
      !/^[a-f0-9]{64}$/.test(dto.expectedProbabilityVersion)
    )
      throw fail('결제 정보를 확인해주세요', 400);
    const merchant = this.provider.config().merchantId;
    return this.db.transaction(async (m) => {
      await lockUser(m, u);
      const [old] = await m.query(
        'SELECT * FROM payment_intents WHERE user_id=$1 AND idempotency_key=$2',
        [u, key],
      );
      if (old) {
        if (
          old.gacha_id !== dto.gachaId ||
          old.quantity !== dto.quantity ||
          old.unit_price !== dto.expectedUnitPrice ||
          old.probability_version !== dto.expectedProbabilityVersion
        )
          throw fail('같은 요청 번호를 다른 결제에 사용할 수 없습니다');
        return this.present(old);
      }
      const [g] = await m.query('SELECT * FROM gachas WHERE id=$1 FOR UPDATE', [
        dto.gachaId,
      ]);
      if (!g || !g.active || !g.cash_enabled || g.sale_type === 'UNSPECIFIED')
        throw fail('카드 결제가 가능한 상품이 아닙니다');
      if (g.cash_unit_price !== dto.expectedUnitPrice)
        throw fail('가격이 변경되었습니다');
      const p = await loadProbability(m, g.id);
      if (p.version !== dto.expectedProbabilityVersion)
        throw fail('상품·확률 정보가 변경되었습니다');
      const amount = g.cash_unit_price * dto.quantity;
      if (!Number.isSafeInteger(amount) || amount > 2147483647)
        throw fail('결제 금액을 확인해주세요', 400);
      const [{ sold }] = await m.query(
          'SELECT COALESCE(sum(quantity-refunded_quantity),0) AS sold FROM capsule_orders WHERE gacha_id=$1',
          [g.id],
        ),
        [{ reserved }] = await m.query(reservedStockSql, [g.id]),
        [{ legacy }] = await m.query(
          'SELECT count(*) AS legacy FROM draws WHERE gacha_id=$1',
          [g.id],
        );
      if (
        BigInt(sold) +
          BigInt(reserved) +
          BigInt(legacy) +
          BigInt(dto.quantity) >
        BigInt(g.totalStock)
      )
        throw fail('남은 수량이 부족합니다');
      const [{ n }] = await m.query(
        "SELECT count(*) AS n FROM payment_intents WHERE user_id=$1 AND (status IN('CONFIRMING','UNKNOWN','APPROVED') OR (status IN('PREPARED','AUTHENTICATED') AND expires_at>clock_timestamp()))",
        [u],
      );
      if (Number(n) >= 5) throw fail('진행 중인 결제를 먼저 확인해주세요');
      const calendar = g.sale_type === 'STANDARD' ? refundCalendar() : null;
      refundTerms(new Date(), g.sale_type, calendar ?? undefined);
      const id = randomUUID();
      await m.query(
        `INSERT INTO payment_intents(id,user_id,idempotency_key,gacha_id,title,quantity,unit_price,amount,probability_snapshot,probability_version,sale_type,refund_calendar,status,merchant_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PREPARED',$13,clock_timestamp()+interval '10 minutes')`,
        [
          id,
          u,
          key,
          g.id,
          g.title,
          dto.quantity,
          g.cash_unit_price,
          amount,
          JSON.stringify(p.snapshot),
          p.version,
          g.sale_type,
          calendar ? JSON.stringify(calendar) : null,
          merchant,
        ],
      );
      await m.query(
        'INSERT INTO payment_prize_refs(payment_id,item_id) SELECT $1::uuid,unnest($2::integer[])',
        [id, p.snapshot.entries.map((e) => e.itemId)],
      );
      return this.present(await this.row(m, u, id));
    });
  }
  async findOne(u: number, id: string) {
    id = validKey(id);
    return this.db.transaction('REPEATABLE READ', async (m) =>
      this.present(await this.row(m, u, id)),
    );
  }
  async byRequest(u: number, key: string) {
    key = validKey(key);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const [r] = await m.query(
        'SELECT * FROM payment_intents WHERE user_id=$1 AND idempotency_key=$2',
        [u, key],
      );
      if (!r) throw fail('확인된 결제 요청이 없습니다', 404);
      return this.present(r);
    });
  }
  async list(u: number, page = 1, limit = 20) {
    validatePage(page, limit);
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const [{ n }] = await m.query(
          'SELECT count(*) AS n FROM payment_intents WHERE user_id=$1',
          [u],
        ),
        rows = await m.query(
          'SELECT * FROM payment_intents WHERE user_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2 LIMIT $3',
          [u, (page - 1) * limit, limit],
        );
      return {
        items: rows.map((r) => this.present(r)),
        totalCount: Number(n),
        page,
        limit,
      };
    });
  }
  async checkout(u: number, id: string) {
    this.require();
    id = validKey(id);
    const r = await this.db.transaction((m) => this.row(m, u, id));
    if (
      r.status !== 'PREPARED' ||
      new Date(r.expires_at).getTime() <= Date.now()
    )
      throw fail('새 결제 요청을 만들어주세요');
    const cfg = this.provider.config();
    if (cfg.merchantId !== r.merchant_id)
      throw fail('결제 상점 설정이 변경되었습니다');
    const api = process.env.PUBLIC_API_ORIGIN;
    if (api !== 'https://gacha-vault-backend.onrender.com')
      throw fail('결제 복귀 주소 설정이 필요합니다', 503);
    return {
      clientKey: cfg.clientKey,
      params: {
        paymentsMethod: 'CARD',
        card: {},
        orderId: r.id,
        orderName: 'GACHIGACHA ' + r.quantity + ' capsules',
        userId: String(u),
        amount: r.amount,
        merchantId: r.merchant_id,
        successUrl: api + '/payments/return',
        failUrl: api + '/payments/return',
      },
    };
  }
  async cancelPrepared(u: number, id: string) {
    id = validKey(id);
    return this.db.transaction(async (m) => {
      await lockUser(m, u);
      const r = await this.row(m, u, id);
      if (r.status === 'CANCELLED') return this.present(r);
      if (r.status !== 'PREPARED')
        throw fail('승인 처리 중인 결제는 취소 결과 확인이 필요합니다');
      await m.query(
        "UPDATE payment_intents SET status='CANCELLED',updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      return this.present(await this.row(m, u, id));
    });
  }
  async confirm(u: number, id: string, transactionId: string, amount: number) {
    this.require();
    id = validKey(id);
    if (
      !/^[A-Za-z0-9_-]{1,32}$/.test(transactionId) ||
      !Number.isInteger(amount)
    )
      throw fail('결제 인증 결과를 확인해주세요', 400);
    const dispatch = await this.db.transaction(async (m) => {
      await lockUser(m, u);
      const r = await this.row(m, u, id);
      if (
        amount !== r.amount ||
        (r.transaction_id && r.transaction_id !== transactionId)
      )
        throw fail('결제 인증 정보가 주문과 일치하지 않습니다');
      if (r.status === 'APPROVED' || r.status === 'PAID')
        return { dispatch: false, r };
      if (['CONFIRMING', 'UNKNOWN'].includes(r.status))
        return { dispatch: false, r };
      if (
        r.status !== 'PREPARED' ||
        new Date(r.expires_at).getTime() <= Date.now()
      )
        throw fail('결제 요청이 만료되었거나 취소되었습니다');
      if (r.merchant_id !== this.provider.config().merchantId)
        throw fail('결제 상점 설정이 변경되었습니다');
      await m.query(
        "UPDATE payment_intents SET status='CONFIRMING',transaction_id=$1,updated_at=clock_timestamp() WHERE id=$2",
        [transactionId, id],
      );
      return { dispatch: true, r: { ...r, transaction_id: transactionId } };
    });
    if (!dispatch.dispatch)
      return dispatch.r.status === 'APPROVED'
        ? this.fulfill(u, id)
        : this.present(dispatch.r);
    const outcome = await this.provider.confirm({
      transactionId,
      merchantId: dispatch.r.merchant_id,
      orderId: id,
      amount: dispatch.r.amount,
    });
    await this.db.transaction(async (m) => {
      await lockUser(m, u);
      const r = await this.row(m, u, id);
      if (r.status !== 'CONFIRMING') return;
      await m.query(
        'UPDATE payment_intents SET status=$1,provider_receipt=$2,updated_at=clock_timestamp() WHERE id=$3',
        [
          outcome.confirmed ? 'APPROVED' : 'UNKNOWN',
          JSON.stringify({
            ...outcome,
            approvedAt: outcome.confirmed ? new Date().toISOString() : null,
          }),
          id,
        ],
      );
    });
    return outcome.confirmed ? this.fulfill(u, id) : this.findOne(u, id);
  }
  private async fulfill(u: number, id: string) {
    return this.db.transaction(async (m) => {
      const user = await lockUser(m, u),
        r = await this.row(m, u, id);
      if (r.status === 'PAID') return this.present(r);
      if (r.status !== 'APPROVED')
        throw fail('결제 승인 결과를 먼저 확인해주세요');
      await m.query('SELECT id FROM gachas WHERE id=$1 FOR UPDATE', [
        r.gacha_id,
      ]);
      const now = new Date(r.provider_receipt.approvedAt),
        terms = refundTerms(now, r.sale_type, r.refund_calendar ?? undefined),
        orderId = randomUUID();
      await m.query(
        `INSERT INTO capsule_orders(id,user_id,idempotency_key,gacha_id,title_snapshot,unit_price,quantity,total,currency,status,wallet_transaction_id,balance_after,probability_snapshot,probability_version,refund_eligible,refund_until,refund_policy,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'KRW','PAID',NULL,$9,$10,$11,$12,$13,$14,$15)`,
        [
          orderId,
          u,
          r.id,
          r.gacha_id,
          r.title,
          r.unit_price,
          r.quantity,
          r.amount,
          String(user.balance),
          JSON.stringify(r.probability_snapshot),
          r.probability_version,
          terms.eligible,
          terms.until,
          JSON.stringify(terms.policy),
          now,
        ],
      );
      await m.query(
        'INSERT INTO order_prize_refs(order_id,item_id) SELECT $1::uuid,unnest($2::integer[])',
        [orderId, r.probability_snapshot.entries.map((e) => e.itemId)],
      );
      for (let i = 0; i < r.quantity; i++)
        await m.query(
          "INSERT INTO owned_capsules(id,order_id,sequence,status) VALUES($1,$2,$3,'UNOPENED')",
          [randomUUID(), orderId, i + 1],
        );
      await m.query(
        "UPDATE payment_intents SET status='PAID',order_id=$1,updated_at=clock_timestamp() WHERE id=$2",
        [orderId, id],
      );
      return this.present(await this.row(m, u, id));
    });
  }
}
