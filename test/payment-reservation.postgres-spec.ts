import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { OrdersService } from '../src/modules/orders/orders.service';
import { PaymentsService } from '../src/modules/commerce/payments.service';
import { loadProbability } from '../src/modules/orders/probability';
import { reservedStockSql } from '../src/modules/commerce/commerce.db';

// Real PostgreSQL, synthetic data, mocked PG only. Never accepts remote credentials.
const db = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
  username: 'gacha_ci', password: 'local-ci-only',
  database: 'gacha_integration_test', synchronize: false,
  extra: { max: 60, statement_timeout: 12000, connectionTimeoutMillis: 12000 },
});
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await pause(20);
  }
  throw new Error('Timed out waiting for ' + label);
}
const observed = <T>(p: Promise<T>) => p.then(
  (value) => ({ ok: true as const, value }),
  (error) => ({ ok: false as const, error }),
);

describe('card reservation expiry and recovery safety (mock PG)', () => {
  const env = { ...process.env };
  let orders: OrdersService, payments: PaymentsService;
  let confirm: jest.Mock, transactionId: string;
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true' || process.env.NODE_ENV !== 'test')
      throw new Error('Dedicated local test database required');
    Object.assign(process.env, {
      ENABLE_GP_ORDER_PREVIEW: 'true', ENABLE_LEGACY_TRANSACTIONS: 'false',
      REFUND_CALENDAR_JSON: JSON.stringify({
        coverageStart: '2026-01-01', coverageEnd: '2030-12-31', holidays: [],
      }),
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    orders = new OrdersService(db);
  });
  beforeEach(() => {
    transactionId = randomUUID().replace(/-/g, '');
    confirm = jest.fn().mockImplementation(async ({ transactionId }) => ({
      confirmed: true, transactionId, code: 'SUCCESS',
    }));
    payments = new PaymentsService(db, {
      ready: () => true,
      config: () => ({ merchantId: 'SYNTHETIC', clientKey: 'not-a-real-key' }),
      confirm,
    } as any);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  async function user() {
    const [u] = await db.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'synthetic-payment',10000) RETURNING id`, [randomUUID() + '@example.invalid']);
    return u.id as number;
  }
  async function fixture(stock = 1) {
    const owner = await user(), buyer = await user();
    const [g] = await db.query(`INSERT INTO gachas(title,price,currency,"totalStock",sale_type,cash_enabled,cash_unit_price) VALUES('synthetic-payment',100,'GP',$1,'STANDARD',true,100) RETURNING id`, [stock]);
    const [i] = await db.query(`INSERT INTO items(name,rarity,"estimatedValue","isPremium","conversionGP") VALUES('synthetic-prize','N',100,false,10) RETURNING id`);
    await db.query(`INSERT INTO gacha_items(gacha_id,item_id,"probabilityPpm") VALUES($1,$2,1000000)`, [g.id, i.id]);
    const p = await loadProbability(db.manager, g.id);
    return { owner, buyer, g: g.id, dto: {
      gachaId: g.id, quantity: 1, expectedUnitPrice: 100,
      expectedProbabilityVersion: p.version,
    } };
  }
  async function orderCount(g: number) {
    return Number((await db.query('SELECT count(*) AS n FROM capsule_orders WHERE gacha_id=$1', [g]))[0].n);
  }
  const expire = (id: string) => db.query("UPDATE payment_intents SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);

  it('uses the DB clock: an expired reservation cannot revive after another buyer owns the last stock', async () => {
    const f = await fixture();
    const p = await payments.prepare(f.owner, randomUUID(), f.dto);
    await expire(p.paymentId);
    await orders.purchase(f.buyer, randomUUID(), f.dto);
    // Model application clock lag without changing the PostgreSQL clock.
    jest.spyOn(Date, 'now').mockReturnValue(0);
    const result = await observed(payments.confirm(f.owner, p.paymentId, transactionId, 100));
    expect(await orderCount(f.g)).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.error.getStatus()).toBe(409);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rechecks expiry after a real payment-row lock wait before dispatching to the PG', async () => {
    const f = await fixture();
    const p = await payments.prepare(f.owner, randomUUID(), f.dto);
    await db.query("UPDATE payment_intents SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1", [p.paymentId]);
    const blocker = db.createQueryRunner();
    let approval: ReturnType<typeof observed<any>> | undefined;
    let purchase: ReturnType<typeof observed<any>> | undefined;
    try {
      await blocker.connect();
      await blocker.startTransaction();
      const [{ pid }] = await blocker.query('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM payment_intents WHERE id=$1 FOR UPDATE', [p.paymentId]);
      approval = observed(payments.confirm(f.owner, p.paymentId, transactionId, 100));
      await until(async () => (await db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))) AS waiting', [pid]))[0].waiting, 'approval blocked by payment row');
      await until(async () => (await db.query('SELECT expires_at<=clock_timestamp() AS expired FROM payment_intents WHERE id=$1', [p.paymentId]))[0].expired, 'reservation expiry');
      purchase = observed(orders.purchase(f.buyer, randomUUID(), f.dto));
      await blocker.rollbackTransaction();
      const [a, b] = await Promise.all([approval, purchase]);
      expect(a.ok).toBe(false);
      if (a.ok === false) expect(a.error.getStatus()).toBe(409);
      expect(b.ok).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
      expect(await orderCount(f.g)).toBe(1);
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await Promise.all([approval, purchase].filter(Boolean));
    }
  }, 20000);

  it('shares the final stock between 25 card reservations and 25 GP purchases from different users', async () => {
    const f = await fixture();
    const users = await Promise.all(Array.from({ length: 50 }, user));
    const responses = await Promise.all(users.map((u, i) => observed<unknown>(
      i % 2 ? payments.prepare(u, randomUUID(), f.dto) : orders.purchase(u, randomUUID(), f.dto),
    )));
    expect(responses.filter((r) => r.ok)).toHaveLength(1);
    for (const r of responses) if (r.ok === false) {
      expect(r.error.getStatus()).toBe(409);
      expect(r.error.message).toBe('남은 수량이 부족합니다');
    }
    const [{ reserved }] = await db.query(reservedStockSql, [f.g]);
    const sold = await orderCount(f.g);
    expect(sold + Number(reserved)).toBe(1);
    const [{ balance }] = await db.query('SELECT sum("coinBalance") AS balance FROM users WHERE id=ANY($1::integer[])', [users]);
    expect(Number(balance)).toBe(500000 - sold * 100);
    expect(confirm).not.toHaveBeenCalled();
  }, 20000);

  it('retains CONFIRMING and UNKNOWN reservations after expiry without redispatch or cancellation', async () => {
    const f = await fixture();
    const p = await payments.prepare(f.owner, randomUUID(), f.dto);
    let settle!: (value: any) => void;
    confirm.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const running = observed(payments.confirm(f.owner, p.paymentId, transactionId, 100));
    try {
      await until(async () => confirm.mock.calls.length === 1, 'mock PG dispatch');
      await expire(p.paymentId);
      await expect(orders.purchase(f.buyer, randomUUID(), f.dto)).rejects.toMatchObject({ status: 409 });
      const inProgress = await payments.confirm(f.owner, p.paymentId, transactionId, 100);
      expect(inProgress.status).toBe('CONFIRMING');
      settle({ confirmed: false });
      const result = await running;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('UNKNOWN');
      expect((await payments.confirm(f.owner, p.paymentId, transactionId, 100)).status).toBe('UNKNOWN');
      await expect(payments.cancelPrepared(f.owner, p.paymentId)).rejects.toMatchObject({ status: 409 });
      await expect(orders.purchase(f.buyer, randomUUID(), f.dto)).rejects.toMatchObject({ status: 409 });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(await orderCount(f.g)).toBe(0);
    } finally { if (settle) settle({ confirmed: false }); await running; }
  });

  it('cancels a prepared reservation idempotently and does not revive it on a late callback', async () => {
    const f = await fixture();
    const p = await payments.prepare(f.owner, randomUUID(), f.dto);
    const cancelled = await Promise.all(Array.from({ length: 6 }, () => payments.cancelPrepared(f.owner, p.paymentId)));
    expect(cancelled.every((r) => r.status === 'CANCELLED')).toBe(true);
    await orders.purchase(f.buyer, randomUUID(), f.dto);
    await expect(payments.confirm(f.owner, p.paymentId, transactionId, 100)).rejects.toMatchObject({ status: 409 });
    expect(confirm).not.toHaveBeenCalled();
    expect(await orderCount(f.g)).toBe(1);
  });

  it('recovers an approved payment after issuance rollback without a second PG approval', async () => {
    const f = await fixture();
    const p = await payments.prepare(f.owner, randomUUID(), f.dto);
    const tag = 'payment_fail_' + randomUUID().replace(/-/g, '');
    await db.query(`CREATE FUNCTION ${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM capsule_orders WHERE id=NEW.order_id AND gacha_id=${Number(f.g)}) THEN RAISE EXCEPTION 'synthetic payment issuance failure'; END IF; RETURN NEW; END $$`);
    try {
      await db.query(`CREATE TRIGGER ${tag} BEFORE INSERT ON owned_capsules FOR EACH ROW EXECUTE FUNCTION ${tag}()`);
      await expect(payments.confirm(f.owner, p.paymentId, transactionId, 100)).rejects.toThrow('synthetic payment issuance failure');
      expect((await payments.findOne(f.owner, p.paymentId)).status).toBe('APPROVED');
      expect(await orderCount(f.g)).toBe(0);
      await expire(p.paymentId);
      await expect(orders.purchase(f.buyer, randomUUID(), f.dto)).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${tag} ON owned_capsules`);
      await db.query(`DROP FUNCTION ${tag}()`);
    }
    const recovered = await Promise.all(Array.from({ length: 6 }, () => payments.confirm(f.owner, p.paymentId, transactionId, 100)));
    expect(recovered.every((r) => r.status === 'PAID')).toBe(true);
    expect(new Set(recovered.map((r) => r.orderId)).size).toBe(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await orderCount(f.g)).toBe(1);
    const [{ n }] = await db.query('SELECT count(*) AS n FROM owned_capsules WHERE order_id=$1', [recovered[0].orderId]);
    expect(Number(n)).toBe(1);
    const [{ balance }] = await db.query('SELECT "coinBalance" AS balance FROM users WHERE id=$1', [f.owner]);
    expect(Number(balance)).toBe(10000); // Card purchase must not debit GP.
  });

  it('rejects wrong owners and mismatched amount before calling the provider', async () => {
    const f = await fixture();
    const p = await payments.prepare(f.owner, randomUUID(), f.dto);
    await expect(payments.confirm(f.buyer, p.paymentId, transactionId, 100)).rejects.toMatchObject({ status: 404 });
    await expect(payments.confirm(f.owner, p.paymentId, transactionId, 200)).rejects.toMatchObject({ status: 409 });
    expect(confirm).not.toHaveBeenCalled();
    expect((await payments.findOne(f.owner, p.paymentId)).status).toBe('PREPARED');
  });
});
