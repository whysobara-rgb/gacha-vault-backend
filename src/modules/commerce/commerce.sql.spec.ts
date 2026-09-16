import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';
import { HistoryService } from './history.service';
import { refundCalendar, refundTerms } from './commerce.policy';
import { loadProbability } from '../orders/probability';
const calendar = {
  coverageStart: '2026-01-01',
  coverageEnd: '2028-12-31',
  holidays: ['2026-09-16'],
};
describe('payment/refund PostgreSQL SQL lifecycle (WASM)', () => {
  let db: PGlite,
    pay: PaymentsService,
    refunds: RefundsService,
    history: HistoryService;
  const env = { ...process.env };
  const provider = {
    ready: () => true,
    config: () => ({
      merchantId: 'TEST_MERCHANT',
      clientKey: 'CL_TEST_fixture',
    }),
    confirm: jest.fn(async (b: any) => ({
      confirmed: true,
      transactionId: b.transactionId,
      code: 'SUCCESS',
    })),
    cancel: jest.fn(async (_body: any) => ({
      confirmed: true,
      transactionId: randomUUID().replace(/-/g, ''),
      code: 'SUCCESS',
    })),
  };
  const query = async (s: string, p: any[] = []) =>
    (await db.query(s, p)).rows as any[];
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      ENABLE_ORDER_REFUND_PREVIEW: 'true',
      REFUND_CALENDAR_JSON: JSON.stringify(calendar),
    });
    db = new PGlite();
    await db.waitReady;
    for (const f of readdirSync(join(__dirname, '../../database/migrations'))
      .filter((f) => f.endsWith('.ts'))
      .sort()) {
      const Cls: any = Object.values(
        require('../../database/migrations/' + f),
      )[0];
      await db.transaction(async (tx) =>
        new Cls().up({ query: async (s, p) => (await tx.query(s, p)).rows }),
      );
    }
    const adapter = {
      transaction: async (...args: any[]) =>
        db.transaction(async (tx) =>
          args[args.length - 1]({
            query: async (s, p) => (await tx.query(s, p)).rows,
          }),
        ),
    };
    pay = new PaymentsService(
      adapter as unknown as DataSource,
      provider as any,
    );
    refunds = new RefundsService(
      adapter as unknown as DataSource,
      provider as any,
    );
    history = new HistoryService(adapter as unknown as DataSource);
  }, 30000);
  afterAll(async () => {
    await db?.close();
    process.env = env;
  });
  beforeEach(() => jest.clearAllMocks());
  const fixture = async (quantity = 2) => {
    const [u] = await query(
      `INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'test',5000) RETURNING id`,
      [randomUUID() + '@example.invalid'],
    );
    const [g] = await query(
      `INSERT INTO gachas(title,price,currency,"totalStock",sale_type,cash_enabled,cash_unit_price) VALUES('test',100,'GP',100,'STANDARD',true,1000) RETURNING id`,
    );
    const [i] = await query(
      `INSERT INTO items(name,rarity,"estimatedValue","isPremium","conversionGP") VALUES('test','N',100,false,10) RETURNING id`,
    );
    await query(
      'INSERT INTO gacha_items(gacha_id,item_id,weight,"probabilityPpm") VALUES($1,$2,1,1000000)',
      [g.id, i.id],
    );
    const p = await loadProbability({ query } as any, g.id);
    return {
      u: u.id,
      g: g.id,
      quantity,
      version: p.version,
      snapshot: p.snapshot,
      dto: {
        gachaId: g.id,
        quantity,
        expectedUnitPrice: 1000,
        expectedProbabilityVersion: p.version,
      },
    };
  };
  const paid = async (n = 2) => {
    const f = await fixture(n),
      r = await pay.prepare(f.u, randomUUID(), f.dto),
      done = await pay.confirm(
        f.u,
        r.paymentId,
        randomUUID().replace(/-/g, ''),
        r.amount,
      );
    return {
      ...f,
      payment: done,
      orderId: done.orderId,
      capsules: (
        await query(
          'SELECT id FROM owned_capsules WHERE order_id=$1 ORDER BY sequence',
          [done.orderId],
        )
      ).map((r) => r.id),
    };
  };
  it('creates 100 purchased capsules once on approval without changing GP', async () => {
    const f = await fixture(100),
      key = randomUUID(),
      r = await pay.prepare(f.u, key, f.dto);
    expect((await pay.prepare(f.u, key, f.dto)).paymentId).toBe(r.paymentId);
    const tid = randomUUID().replace(/-/g, ''),
      done = await pay.confirm(f.u, r.paymentId, tid, r.amount);
    expect(done.status).toBe('PAID');
    expect((await pay.confirm(f.u, r.paymentId, tid, r.amount)).orderId).toBe(
      done.orderId,
    );
    expect(provider.confirm).toHaveBeenCalledTimes(1);
    expect(
      await query('SELECT id FROM owned_capsules WHERE order_id=$1', [
        done.orderId,
      ]),
    ).toHaveLength(100);
    expect(
      Number(
        (
          await query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [f.u])
        )[0].n,
      ),
    ).toBe(5000);
    expect((await history.orders(f.u)).totalCount).toBe(1);
  });
  it('keeps uncertain approvals reserved without dispatching a second charge', async () => {
    const f = await fixture(),
      r = await pay.prepare(f.u, randomUUID(), f.dto),
      tid = randomUUID().replace(/-/g, '');
    provider.confirm.mockResolvedValueOnce({ confirmed: false } as any);
    expect((await pay.confirm(f.u, r.paymentId, tid, r.amount)).status).toBe(
      'UNKNOWN',
    );
    expect((await pay.confirm(f.u, r.paymentId, tid, r.amount)).status).toBe(
      'UNKNOWN',
    );
    expect(provider.confirm).toHaveBeenCalledTimes(1);
    expect((await history.orders(f.u)).totalCount).toBe(0);
    await expect(pay.cancelPrepared(f.u, r.paymentId)).rejects.toMatchObject({
      status: 409,
    });
  });
  it('does not authorize modified amounts, replayed transaction IDs, expired or cancelled intents', async () => {
    const f = await fixture(),
      r = await pay.prepare(f.u, randomUUID(), f.dto);
    await expect(
      pay.confirm(f.u, r.paymentId, 'test', r.amount + 1),
    ).rejects.toMatchObject({ status: 409 });
    expect(provider.confirm).not.toHaveBeenCalled();
    await pay.cancelPrepared(f.u, r.paymentId);
    await expect(
      pay.confirm(f.u, r.paymentId, 'test', r.amount),
    ).rejects.toMatchObject({ status: 409 });
    const q = await pay.prepare(f.u, randomUUID(), f.dto);
    await query(
      "UPDATE payment_intents SET expires_at=now()-interval '1 second' WHERE id=$1",
      [q.paymentId],
    );
    await expect(
      pay.confirm(f.u, q.paymentId, 'test', q.amount),
    ).rejects.toMatchObject({ status: 409 });
    const paidOrder = await paid(1),
      other = await fixture(1),
      p = await pay.prepare(other.u, randomUUID(), other.dto),
      [{ transaction_id }] = await query(
        'SELECT transaction_id FROM payment_intents WHERE id=$1',
        [paidOrder.payment.paymentId],
      );
    await expect(
      pay.confirm(other.u, p.paymentId, transaction_id, p.amount),
    ).rejects.toThrow();
    expect((await pay.findOne(other.u, p.paymentId)).status).toBe('PREPARED');
  });
  it('reserves stock at checkout and releases only expired prepared or cancelled intents', async () => {
    const f = await fixture(100),
      r = await pay.prepare(f.u, randomUUID(), f.dto);
    await expect(pay.prepare(f.u, randomUUID(), f.dto)).rejects.toMatchObject({
      status: 409,
    });
    await pay.cancelPrepared(f.u, r.paymentId);
    const next = await pay.prepare(f.u, randomUUID(), f.dto);
    await query(
      "UPDATE payment_intents SET expires_at=now()-interval '1 second' WHERE id=$1",
      [next.paymentId],
    );
    expect((await pay.prepare(f.u, randomUUID(), f.dto)).status).toBe(
      'PREPARED',
    );
  });
  it('partially refunds only selected unopened capsules and refunds to the original card', async () => {
    const f = await paid(),
      ids = [f.capsules[0]],
      q = await refunds.quote(f.u, f.orderId, ids),
      key = randomUUID(),
      dto = {
        capsuleIds: ids,
        expectedAmount: q.amount,
        reason: 'change of mind',
      };
    const r = await refunds.refund(f.u, f.orderId, key, dto);
    expect(r.status).toBe('SUCCEEDED');
    expect(r.currency).toBe('KRW');
    expect(r.balanceAfter).toBeNull();
    expect((await refunds.refund(f.u, f.orderId, key, dto)).refundId).toBe(
      r.refundId,
    );
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(provider.cancel.mock.calls[0][0]).toMatchObject({
      amount: 1000,
      partial: true,
    });
    expect(
      (
        await query(
          'SELECT status,refunded_quantity FROM capsule_orders WHERE id=$1',
          [f.orderId],
        )
      )[0],
    ).toMatchObject({ status: 'PARTIALLY_REFUNDED', refunded_quantity: 1 });
    expect(
      (
        await query('SELECT status FROM owned_capsules WHERE id=$1', [
          f.capsules[1],
        ])
      )[0].status,
    ).toBe('UNOPENED');
    expect(
      Number(
        (
          await query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [f.u])
        )[0].n,
      ),
    ).toBe(5000);
  });
  it('holds capsules while a card refund is uncertain and avoids repeated cancellation calls', async () => {
    const f = await paid(),
      q = await refunds.quote(f.u, f.orderId, f.capsules),
      key = randomUUID(),
      dto = {
        capsuleIds: f.capsules,
        expectedAmount: q.amount,
        reason: 'test',
      };
    provider.cancel.mockResolvedValueOnce({ confirmed: false } as any);
    expect((await refunds.refund(f.u, f.orderId, key, dto)).status).toBe(
      'UNKNOWN',
    );
    expect((await refunds.refund(f.u, f.orderId, key, dto)).status).toBe(
      'UNKNOWN',
    );
    expect(provider.cancel).toHaveBeenCalledTimes(1);
    expect(
      (
        await query('SELECT status FROM owned_capsules WHERE order_id=$1', [
          f.orderId,
        ])
      ).every((c) => c.status === 'REFUND_PENDING'),
    ).toBe(true);
    await expect(
      refunds.quote(f.u, f.orderId, f.capsules),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects opened, foreign, expired, event and old unclassified orders', async () => {
    const f = await paid(),
      other = await fixture();
    await expect(
      refunds.quote(other.u, f.orderId, f.capsules),
    ).rejects.toMatchObject({ status: 404 });
    await query("UPDATE owned_capsules SET status='OPENED' WHERE id=$1", [
      f.capsules[0],
    ]);
    await expect(
      refunds.quote(f.u, f.orderId, [f.capsules[0]]),
    ).rejects.toMatchObject({ status: 409 });
    await query(
      "UPDATE capsule_orders SET refund_until=now()-interval '1 second' WHERE id=$1",
      [f.orderId],
    );
    await expect(
      refunds.quote(f.u, f.orderId, [f.capsules[1]]),
    ).rejects.toMatchObject({ status: 409 });
    const event = await fixture();
    await query("UPDATE gachas SET sale_type='EVENT' WHERE id=$1", [event.g]);
    const intent = await pay.prepare(event.u, randomUUID(), event.dto),
      done = await pay.confirm(
        event.u,
        intent.paymentId,
        randomUUID().replace(/-/g, ''),
        intent.amount,
      );
    expect(
      (
        await query('SELECT refund_eligible FROM capsule_orders WHERE id=$1', [
          done.orderId,
        ])
      )[0].refund_eligible,
    ).toBe(false);
  });
  it('returns GP once and rolls back GP/capsule updates if the refund ledger fails', async () => {
    const f = await paid(1);
    const [w] = await query(
      `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",description) VALUES($1,'USE',-1000,5000,'fixture') RETURNING id`,
      [f.u],
    );
    await query(
      "UPDATE capsule_orders SET currency='GP',wallet_transaction_id=$1 WHERE id=$2",
      [w.id, f.orderId],
    );
    const dto = {
        capsuleIds: f.capsules,
        expectedAmount: 1000,
        reason: 'test',
      },
      key = randomUUID();
    await query(
      `CREATE FUNCTION fail_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin='CAPSULE_REFUND' THEN RAISE EXCEPTION 'simulated refund'; END IF; RETURN NEW; END $$`,
    );
    await query(
      'CREATE TRIGGER fail_refund BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION fail_refund()',
    );
    try {
      await expect(refunds.refund(f.u, f.orderId, key, dto)).rejects.toThrow(
        'simulated refund',
      );
      expect(
        (
          await query('SELECT status FROM owned_capsules WHERE id=$1', [
            f.capsules[0],
          ])
        )[0].status,
      ).toBe('UNOPENED');
      expect((await refunds.list(f.u)).totalCount).toBe(0);
    } finally {
      await query('DROP TRIGGER fail_refund ON wallet_transactions');
      await query('DROP FUNCTION fail_refund()');
    }
    await refunds.refund(f.u, f.orderId, key, dto);
    await refunds.refund(f.u, f.orderId, key, dto);
    expect(
      Number(
        (
          await query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [f.u])
        )[0].n,
      ),
    ).toBe(6000);
    expect(provider.cancel).not.toHaveBeenCalled();
  });
  it('recovers approved payment delivery after a DB failure without charging again', async () => {
    const f = await fixture(1),
      r = await pay.prepare(f.u, randomUUID(), f.dto),
      tid = randomUUID().replace(/-/g, '');
    await query(
      `CREATE FUNCTION fail_capsule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated delivery'; END $$`,
    );
    await query(
      'CREATE TRIGGER fail_capsule BEFORE INSERT ON owned_capsules FOR EACH ROW EXECUTE FUNCTION fail_capsule()',
    );
    try {
      await expect(
        pay.confirm(f.u, r.paymentId, tid, r.amount),
      ).rejects.toThrow('simulated delivery');
      expect((await pay.findOne(f.u, r.paymentId)).status).toBe('APPROVED');
      expect((await history.orders(f.u)).totalCount).toBe(0);
    } finally {
      await query('DROP TRIGGER fail_capsule ON owned_capsules');
      await query('DROP FUNCTION fail_capsule()');
    }
    expect((await pay.confirm(f.u, r.paymentId, tid, r.amount)).status).toBe(
      'PAID',
    );
    expect(provider.confirm).toHaveBeenCalledTimes(1);
  });
  it('keeps refunds and purchase histories owner-scoped, stable and paginated', async () => {
    const f = await paid(1),
      other = await fixture();
    await expect(
      pay.findOne(other.u, f.payment.paymentId),
    ).rejects.toMatchObject({ status: 404 });
    expect((await history.orders(f.u, 1, 1)).items[0].orderId).toBe(f.orderId);
    expect((await history.orders(other.u)).totalCount).toBe(0);
    const q = await refunds.quote(f.u, f.orderId, f.capsules),
      r = await refunds.refund(f.u, f.orderId, randomUUID(), {
        capsuleIds: f.capsules,
        expectedAmount: q.amount,
        reason: 'test',
      });
    await expect(refunds.findOne(other.u, r.refundId)).rejects.toMatchObject({
      status: 404,
    });
    expect((await refunds.list(f.u, 1, 1)).items[0].refundId).toBe(r.refundId);
  });
  it('counts seven Korea business days, excludes configured holidays, and freezes the calendar version', () => {
    const terms = refundTerms(
      new Date('2026-09-14T15:01:00Z'),
      'STANDARD',
      calendar,
    );
    expect(terms.until?.toISOString()).toBe('2026-09-25T14:59:59.999Z');
    expect(refundTerms(new Date(), 'EVENT').eligible).toBe(false);
    expect(() => refundCalendar({})).toThrow();
    expect(() =>
      refundTerms(new Date('2029-01-01'), 'STANDARD', calendar),
    ).toThrow();
    expect(() =>
      refundCalendar({
        REFUND_CALENDAR_JSON: JSON.stringify({
          ...calendar,
          holidays: ['2026-09-16', '2026-09-16'],
        }),
      }),
    ).toThrow();
  });
});
