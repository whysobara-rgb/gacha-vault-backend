import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { User } from '../src/entities';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy';
import { OrdersService } from '../src/modules/orders/orders.service';
import { PaymentsService } from '../src/modules/commerce/payments.service';
import { RefundsService } from '../src/modules/commerce/refunds.service';
import { OperatorRefundsController } from '../src/modules/commerce/operator-refunds.controller';
import { ResponseTransformInterceptor } from '../src/common/interceptors/response-transform.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

// Synthetic records/tokens and mocked PG. A new local DB per suite, never Render.
const name = 'gacha_operator_' + randomUUID().replace(/-/g, '');
const local = { type: 'postgres' as const, host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432), username: 'gacha_ci',
  password: 'local-ci-only', ssl: false, synchronize: false, migrationsRun: false,
  dropSchema: false, logging: false as const, extra: { max: 24, statement_timeout: 12000 } };
const admin = new DataSource({ ...local, database: 'postgres' });
const db = new DataSource({ ...dataSourceOptions, ...local, database: name });
const observe = <T>(p: Promise<T>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
async function until(check: () => Promise<boolean>) {
  const end = performance.now() + 5000;
  while (performance.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Synthetic race barrier timed out');
}
jest.setTimeout(30000);
describe('operator original-payment refunds (local PostgreSQL and mock PG)', () => {
  const env = { ...process.env };
  let jwt: JwtService;
  let created = false, app: INestApplication, origin: string;
  let orders: OrdersService, payments: PaymentsService, refunds: RefundsService;
  let cancel: jest.Mock, provider: any;
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true' || process.env.NODE_ENV !== 'test') throw new Error('Local opt-in required');
    Object.assign(process.env, { ENABLE_GP_ORDER_PREVIEW: 'true', ENABLE_ORDER_REFUND_PREVIEW: 'true',
      ENABLE_OPERATOR_REFUND_PREVIEW: 'true', ENABLE_LEGACY_TRANSACTIONS: 'false',
      REFUND_CALENDAR_JSON: JSON.stringify({ coverageStart: '2026-01-01', coverageEnd: '2030-12-31', holidays: [] }) });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
    await db.initialize(); await db.runMigrations({ transaction: 'all' });
    cancel = jest.fn();
    provider = { ready: () => true, config: () => ({ merchantId: 'SYNTHETIC_OPERATOR' }),
      confirm: async ({ transactionId }: any) => ({ confirmed: true, transactionId }), cancel };
    orders = new OrdersService(db); payments = new PaymentsService(db, provider); refunds = new RefundsService(db, provider);
    const secret = randomUUID() + randomUUID();
    const module = await Test.createTestingModule({ imports: [PassportModule], controllers: [OperatorRefundsController],
      providers: [JwtStrategy, { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: getRepositoryToken(User), useValue: db.getRepository(User) }, { provide: RefundsService, useValue: refunds }] }).compile();
    jwt = new JwtService({ secret });
    app = module.createNestApplication({ logger: false });
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  });
  beforeEach(() => { cancel.mockReset(); cancel.mockImplementation(async () => ({ confirmed: true, transactionId: randomUUID().replace(/-/g, '') })); });
  afterAll(async () => {
    try { if (app) await app.close(); if (db.isInitialized) await db.destroy(); if (created) await admin.query(`DROP DATABASE "${name}"`); }
    finally { if (admin.isInitialized) await admin.destroy(); process.env = env; }
  });
  async function account(permission?: string) {
    const email = randomUUID() + '@example.invalid';
    const [u] = await db.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'synthetic-operator',10000) RETURNING id`, [email]);
    if (permission) await db.query('INSERT INTO operations_permissions(user_id,permission) VALUES($1,$2)', [u.id, permission]);
    return { userId: u.id as number, email, authVersion: 0 };
  }
  async function fixture(currency = 'GP', quantity = 1) {
    const actor = await account('OWNER'), customer = await account();
    const [g] = await db.query(`INSERT INTO gachas(title,price,currency,"totalStock",sale_type,cash_enabled,cash_unit_price) VALUES('operator-test',100,'GP',100,'STANDARD',true,100) RETURNING id`);
    const [i] = await db.query(`INSERT INTO items(name,"estimatedValue","isPremium","conversionGP") VALUES('synthetic item',1000,false,100) RETURNING id`);
    await db.query('INSERT INTO gacha_items(gacha_id,item_id,"probabilityPpm") VALUES($1,$2,1000000)', [g.id, i.id]);
    const p = await orders.odds(g.id), dto = { gachaId: g.id, quantity, expectedUnitPrice: 100, expectedProbabilityVersion: p.version };
    let order: any;
    if (currency === 'GP') order = await orders.purchase(customer.userId, randomUUID(), dto);
    else {
      const prepared = await payments.prepare(customer.userId, randomUUID(), dto);
      const paid = await payments.confirm(customer.userId, prepared.paymentId, randomUUID().replace(/-/g, ''), 100 * quantity);
      order = await orders.findOne(customer.userId, paid.orderId);
    }
    return { actor, customer, g: g.id, order, body: { orderId: order.orderId, capsuleIds: [order.capsules[0].id],
      expectedAmount: 100, expectedCurrency: currency as 'GP' | 'KRW', reason: '고객 요청에 따른 미개봉 환불' } };
  }
  const submit = (f: any, key = randomUUID()) => refunds.operatorRefund(f.actor, f.order.orderId, key, f.body);
  const count = async (table: string, where: string, args: any[]) => Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, args))[0].n);
  const balance = async (id: number) => Number((await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [id]))[0].n);
  const request = async (method: string, route: string, actor?: any, body?: any, key?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (actor) headers.authorization = 'Bearer ' + jwt.sign({ sub: actor.userId, av: actor.authVersion, role: 'OWNER' }, { expiresIn: '10m' });
    if (key) headers['idempotency-key'] = key;
    const r = await fetch(origin + '/owner/refunds' + route, { method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: await r.json() as any };
  };

  it('requires real database OWNER permission, not an OWNER token claim', async () => {
    const plain = await account(), staff = await account('CATALOG');
    expect((await request('GET', '/capabilities')).status).toBe(401);
    expect((await request('GET', '/capabilities', plain)).status).toBe(403);
    expect((await request('GET', '/capabilities', staff)).status).toBe(403);
    expect((await request('POST', '/quotes', plain, { orderId: randomUUID(), capsuleIds: [randomUUID()] })).status).toBe(403);
  });
  it('quotes the original customer and amount without making a refund', async () => {
    const f = await fixture();
    const r = await request('POST', '/quotes', f.actor, { orderId: f.order.orderId, capsuleIds: f.body.capsuleIds });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ customerId: f.customer.userId, amount: 100, currency: 'GP', productionEnabled: false });
    expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
  it('executes six HTTP retries with one GP credit and two correlated audit records', async () => {
    const f = await fixture(), key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => request('POST', '', f.actor, f.body, key)));
    expect(responses.every(r => r.status === 201 && r.body.data.status === 'SUCCEEDED')).toBe(true);
    const ids = responses.map(r => r.body.data.refundId); expect(new Set(ids).size).toBe(1);
    expect(await balance(f.customer.userId)).toBe(10000); expect(await balance(f.actor.userId)).toBe(10000);
    expect(await count('wallet_transactions', "user_id=$1 AND origin='CAPSULE_REFUND'", [f.customer.userId])).toBe(1);
    const audit = await db.query('SELECT actor_id,event,detail FROM operations_events WHERE target_id=$1 ORDER BY id', [ids[0]]);
    expect(audit.map(r => r.event)).toEqual(['REFUND_REQUESTED', 'REFUND_SUCCEEDED']);
    expect(audit.every(r => r.actor_id === f.actor.userId && r.detail.customerId === f.customer.userId && r.detail.orderId === f.order.orderId)).toBe(true);
    expect((await request('GET', '/by-request/' + key, f.actor)).body.data.refundId).toBe(ids[0]);
    expect((await refunds.findOne(f.customer.userId, ids[0])).status).toBe('SUCCEEDED');
    await expect(refunds.findOne(f.actor.userId, ids[0])).rejects.toMatchObject({ status: 404 });
    expect(cancel).not.toHaveBeenCalled();
  });
  it('rejects amount and currency mismatches before any movement', async () => {
    const f = await fixture('KRW');
    for (const patch of [{ expectedAmount: 200 }, { expectedCurrency: 'GP' }])
      await expect(refunds.operatorRefund(f.actor, f.order.orderId, randomUUID(), { ...f.body, ...patch } as any)).rejects.toMatchObject({ status: 409 });
    expect(cancel).not.toHaveBeenCalled();
    expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(0);
  });
  it('rejects client-supplied customer identity, actor, override policy, and invalid money', async () => {
    const f = await fixture();
    for (const patch of [{ customerId: f.actor.userId }, { actorId: f.customer.userId }, { override: true }, { expectedAmount: 1.5 }])
      expect((await request('POST', '', f.actor, { ...f.body, ...patch }, randomUUID())).status).toBe(400);
    expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(0);
  });
  it('rejects duplicate capsules, another order, expired or already opened capsules', async () => {
    const f = await fixture();
    await expect(refunds.operatorRefund(f.actor, f.order.orderId, randomUUID(), { ...f.body, capsuleIds: [...f.body.capsuleIds, ...f.body.capsuleIds] })).rejects.toMatchObject({ status: 400 });
    await expect(refunds.operatorRefund(f.actor, f.order.orderId, randomUUID(), { ...f.body, capsuleIds: [randomUUID()] })).rejects.toMatchObject({ status: 404 });
    await db.query("UPDATE capsule_orders SET refund_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.order.orderId]);
    await expect(submit(f)).rejects.toMatchObject({ status: 409 });
    const opened = await fixture(); await orders.open(opened.customer.userId, opened.body.capsuleIds[0]);
    await expect(submit(opened)).rejects.toMatchObject({ status: 409 });
    expect(cancel).not.toHaveBeenCalled();
  });
  it('binds repeat request IDs to the exact order, capsule selection, currency, amount and reason', async () => {
    const f = await fixture('GP', 2), key = randomUUID(); await submit(f, key);
    for (const patch of [{ reason: 'changed' }, { expectedAmount: 200 }, { expectedCurrency: 'KRW' }, { capsuleIds: [f.order.capsules[1].id] }])
      await expect(refunds.operatorRefund(f.actor, f.order.orderId, key, { ...f.body, ...patch } as any)).rejects.toMatchObject({ status: 409 });
    const other = await fixture();
    await expect(refunds.operatorRefund(f.actor, other.order.orderId, key, other.body)).rejects.toMatchObject({ status: 409 });
    expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(1);
  });
  it('keeps operator and customer request-ID namespaces separate', async () => {
    const f = await fixture('GP', 2), key = randomUUID();
    const a = await refunds.refund(f.customer.userId, f.order.orderId, key, f.body);
    const b = await refunds.operatorRefund(f.actor, f.order.orderId, key, { ...f.body, capsuleIds: [f.order.capsules[1].id] });
    expect(a.refundId).not.toBe(b.refundId); expect(await balance(f.customer.userId)).toBe(10000);
    expect((await refunds.byRequest(f.customer.userId, key)).refundId).toBe(a.refundId);
    expect((await refunds.operatorByRequest(f.actor, key)).refundId).toBe(b.refundId);
  });
  it('serializes two operators refunding the same capsule', async () => {
    const f = await fixture(), second = await account('OWNER');
    const results = await Promise.all([observe(submit(f)), observe(refunds.operatorRefund(second, f.order.orderId, randomUUID(), f.body))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(1);
    expect(await balance(f.customer.userId)).toBe(10000);
  });
  it('serializes customer refund against operator refund without double credit', async () => {
    const f = await fixture();
    const results = await Promise.all([observe(submit(f)), observe(refunds.refund(f.customer.userId, f.order.orderId, randomUUID(), f.body))]);
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(await balance(f.customer.userId)).toBe(10000);
    expect(await count('wallet_transactions', "user_id=$1 AND origin='CAPSULE_REFUND'", [f.customer.userId])).toBe(1);
  });
  it('allows either opening or operator refund, never both', async () => {
    const f = await fixture();
    const results = await Promise.all([observe<unknown>(submit(f)), observe<unknown>(orders.open(f.customer.userId, f.body.capsuleIds[0]))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const [{ status }] = await db.query('SELECT status FROM owned_capsules WHERE id=$1', f.body.capsuleIds);
    expect(await count('capsule_openings', 'capsule_id=$1', f.body.capsuleIds)).toBe(status === 'OPENED' ? 1 : 0);
    expect(await balance(f.customer.userId)).toBe(status === 'OPENED' ? 9900 : 10000);
  });
  it('refunds a full card payment through the original provider, never as GP', async () => {
    const f = await fixture('KRW'); const result = await submit(f);
    expect(result).toMatchObject({ currency: 'KRW', amount: 100, status: 'SUCCEEDED', balanceAfter: null });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toMatchObject({ merchantId: 'SYNTHETIC_OPERATOR', amount: 100, partial: false });
    expect(await balance(f.customer.userId)).toBe(10000);
    expect(await count('wallet_transactions', "user_id=$1 AND origin='CAPSULE_REFUND'", [f.customer.userId])).toBe(0);
  });
  it('handles sequential partial card refunds with original amount and transaction reference', async () => {
    const f = await fixture('KRW', 3); await submit(f);
    await refunds.operatorRefund(f.actor, f.order.orderId, randomUUID(), { ...f.body, capsuleIds: f.order.capsules.slice(1).map(c => c.id), expectedAmount: 200 });
    expect(cancel.mock.calls.map(c => [c[0].amount, c[0].partial])).toEqual([[100, true], [200, true]]);
    expect(cancel.mock.calls[0][0].transactionId).toBe(cancel.mock.calls[1][0].transactionId);
    expect((await orders.findOne(f.customer.userId, f.order.orderId)).refundedQuantity).toBe(3);
  });
  it('retains UNKNOWN refunds, exposes lookup after writes stop, and never resends cancellation', async () => {
    const f = await fixture('KRW'), key = randomUUID(); cancel.mockResolvedValue({ confirmed: false });
    expect((await submit(f, key)).status).toBe('UNKNOWN');
    const repeat = await Promise.all(Array.from({ length: 6 }, () => submit(f, key)));
    expect(repeat.every(r => r.status === 'UNKNOWN')).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
    await expect(submit(f)).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT status FROM owned_capsules WHERE id=$1', f.body.capsuleIds))[0].status).toBe('REFUND_PENDING');
    process.env.ENABLE_OPERATOR_REFUND_PREVIEW = 'false';
    try { expect((await refunds.operatorByRequest(f.actor, key)).status).toBe('UNKNOWN'); }
    finally { process.env.ENABLE_OPERATOR_REFUND_PREVIEW = 'true'; }
    expect(await count('operations_events', "target_id=$1 AND event='REFUND_UNKNOWN'", [repeat[0].refundId])).toBe(1);
  });
  it('does not dispatch again after a thrown provider response', async () => {
    const f = await fixture('KRW'), key = randomUUID(); cancel.mockRejectedValue(new Error('synthetic network failure'));
    await expect(submit(f, key)).rejects.toThrow('synthetic network failure');
    expect((await submit(f, key)).status).toBe('PROCESSING'); expect(cancel).toHaveBeenCalledTimes(1);
    expect((await refunds.operatorByRequest(f.actor, key)).status).toBe('PROCESSING');
  });
  it('fails closed if the initial audit cannot be recorded', async () => {
    const f = await fixture('KRW');
    const tag = 'reject_audit_' + randomUUID().replace(/-/g, '');
    await db.query(`CREATE FUNCTION ${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_id=${f.actor.userId} AND NEW.event='REFUND_REQUESTED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${tag} BEFORE INSERT ON operations_events FOR EACH ROW EXECUTE FUNCTION ${tag}()`);
    try { await expect(submit(f)).rejects.toThrow('synthetic audit failure'); }
    finally { await db.query(`DROP TRIGGER ${tag} ON operations_events`); await db.query(`DROP FUNCTION ${tag}()`); }
    expect(cancel).not.toHaveBeenCalled(); expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(0);
    expect(await count('operations_requests', 'actor_id=$1', [f.actor.userId])).toBe(0);
    expect((await db.query('SELECT status FROM owned_capsules WHERE id=$1', f.body.capsuleIds))[0].status).toBe('UNOPENED');
  });
  it('recovers approved card cancellation after completion audit failure without another PG call', async () => {
    const f = await fixture('KRW'), key = randomUUID(), tag = 'reject_finish_' + randomUUID().replace(/-/g, '');
    await db.query(`CREATE FUNCTION ${tag}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_id=${f.actor.userId} AND NEW.event='REFUND_SUCCEEDED' THEN RAISE EXCEPTION 'synthetic completion failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${tag} BEFORE INSERT ON operations_events FOR EACH ROW EXECUTE FUNCTION ${tag}()`);
    try { await expect(submit(f, key)).rejects.toThrow('synthetic completion failure'); }
    finally { await db.query(`DROP TRIGGER ${tag} ON operations_events`); await db.query(`DROP FUNCTION ${tag}()`); }
    expect((await refunds.operatorByRequest(f.actor, key)).status).toBe('APPROVED');
    expect((await orders.findOne(f.customer.userId, f.order.orderId)).refundedQuantity).toBe(0);
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(f, key)));
    expect(results.every(r => r.status === 'SUCCEEDED')).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
    expect((await orders.findOne(f.customer.userId, f.order.orderId)).refundedQuantity).toBe(1);
    expect((await db.query('SELECT event FROM operations_events WHERE target_id=$1 ORDER BY id', [results[0].refundId])).map(r => r.event)).toEqual(['REFUND_REQUESTED', 'REFUND_APPROVED', 'REFUND_SUCCEEDED']);
  });
  it('completes an already authorized in-flight cancellation but blocks revoked actors from new requests', async () => {
    const f = await fixture('KRW'), key = randomUUID(); let resolve!: (v: any) => void;
    cancel.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = observe(submit(f, key));
    try {
      await until(async () => cancel.mock.calls.length === 1);
      expect((await submit(f, key)).status).toBe('PROCESSING');
      await db.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [f.actor.userId]);
      await db.query("UPDATE operations_permissions SET active=false WHERE user_id=$1 AND permission='OWNER'", [f.actor.userId]);
      resolve({ confirmed: true, transactionId: randomUUID().replace(/-/g, '') });
      const result = await pending; expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('SUCCEEDED');
      await expect(submit(f, key)).rejects.toMatchObject({ status: 401 });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { if (resolve) resolve({ confirmed: false }); await pending; }
  });
  it('rechecks role revocation after waiting for a customer lock', async () => {
    const f = await fixture(), blocker = db.createQueryRunner(); let pending: any;
    try {
      await blocker.connect(); await blocker.startTransaction();
      const [{ pid }] = await blocker.query('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.customer.userId]);
      pending = observe(submit(f));
      await until(async () => (await db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))) AS waiting', [pid]))[0].waiting);
      await db.query("UPDATE operations_permissions SET active=false WHERE user_id=$1 AND permission='OWNER'", [f.actor.userId]);
      await blocker.rollbackTransaction();
      const result = await pending; expect(result.ok).toBe(false); if (result.ok === false) expect(result.error.status).toBe(403);
      expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(0);
    } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); await blocker.release(); if (pending) await pending; }
  });
  it('never enables operator writes in production even with all preview flags set', async () => {
    const f = await fixture(); process.env.NODE_ENV = 'production';
    try {
      expect((await request('GET', '/capabilities', f.actor)).body.data).toMatchObject({ enabled: false, productionEnabled: false });
      expect((await request('POST', '', f.actor, f.body, randomUUID())).status).toBe(503);
      expect((await request('POST', '/quotes', f.actor, { orderId: f.order.orderId, capsuleIds: f.body.capsuleIds })).status).toBe(503);
      expect(await count('order_refunds', 'order_id=$1', [f.order.orderId])).toBe(0);
    } finally { process.env.NODE_ENV = 'test'; }
  });
});
