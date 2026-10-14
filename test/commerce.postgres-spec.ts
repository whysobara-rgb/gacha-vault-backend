import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { OrdersService } from '../src/modules/orders/orders.service';
import { PaymentsService } from '../src/modules/commerce/payments.service';
import { RefundsService } from '../src/modules/commerce/refunds.service';
import { loadProbability } from '../src/modules/orders/probability';
const db = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
  username: 'gacha_ci',
  password: 'local-ci-only',
  database: 'gacha_integration_test',
  synchronize: false,
  extra: { max: 8, statement_timeout: 10000 },
});
describe('multi-connection purchase/open/refund races', () => {
  const env = { ...process.env };
  let orders: OrdersService, refunds: RefundsService, payments: PaymentsService;
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test DB required');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_GP_ORDER_PREVIEW: 'true',
      ENABLE_ORDER_REFUND_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      REFUND_CALENDAR_JSON: JSON.stringify({
        coverageStart: '2026-01-01',
        coverageEnd: '2030-12-31',
        holidays: [],
      }),
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    const provider = {
      ready: () => true,
      config: () => ({ merchantId: 'TESTMERCHANT' }),
    };
    orders = new OrdersService(db);
    refunds = new RefundsService(db, provider as any);
    payments = new PaymentsService(db, provider as any);
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  const fixture = async (stock = 100) => {
    const [u] = await db.query(
        `INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'race',10000) RETURNING id`,
        [randomUUID() + '@example.invalid'],
      ),
      [g] = await db.query(
        `INSERT INTO gachas(title,price,currency,"totalStock",sale_type,cash_enabled,cash_unit_price) VALUES('race',100,'GP',$1,'STANDARD',true,100) RETURNING id`,
        [stock],
      ),
      [i] = await db.query(
        `INSERT INTO items(name,rarity,"estimatedValue","isPremium","conversionGP") VALUES('race','N',100,false,10) RETURNING id`,
      );
    await db.query(
      'INSERT INTO gacha_items(gacha_id,item_id,weight,"probabilityPpm") VALUES($1,$2,1,1000000)',
      [g.id, i.id],
    );
    const p = await loadProbability(db.manager, g.id);
    return {
      u: u.id,
      g: g.id,
      dto: {
        gachaId: g.id,
        quantity: 1,
        expectedUnitPrice: 100,
        expectedProbabilityVersion: p.version,
      },
    };
  };
  it('six refund retries return one GP credit and release one stock slot', async () => {
    const f = await fixture(),
      o = await orders.purchase(f.u, randomUUID(), f.dto),
      key = randomUUID(),
      dto = {
        capsuleIds: [o.capsules[0].id],
        expectedAmount: 100,
        reason: 'race',
      };
    await Promise.all(
      Array.from({ length: 6 }, () => refunds.refund(f.u, o.orderId, key, dto)),
    );
    expect(
      Number(
        (
          await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
            f.u,
          ])
        )[0].n,
      ),
    ).toBe(10000);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM wallet_transactions WHERE user_id=$1 AND origin='CAPSULE_REFUND'",
            [f.u],
          )
        )[0].n,
      ),
    ).toBe(1);
    expect((await orders.findOne(f.u, o.orderId)).refundedQuantity).toBe(1);
  });
  it('allows either opening or refund of one capsule, never both', async () => {
    const f = await fixture(),
      o = await orders.purchase(f.u, randomUUID(), f.dto),
      id = o.capsules[0].id;
    const all = await Promise.allSettled([
      orders.open(f.u, id),
      refunds.refund(f.u, o.orderId, randomUUID(), {
        capsuleIds: [id],
        expectedAmount: 100,
        reason: 'race',
      }),
    ]);
    expect(all.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const [c] = await db.query(
        'SELECT status FROM owned_capsules WHERE id=$1',
        [id],
      ),
      [{ n }] = await db.query(
        'SELECT count(*) AS n FROM capsule_openings WHERE capsule_id=$1',
        [id],
      );
    expect(Number(n)).toBe(c.status === 'OPENED' ? 1 : 0);
    expect(
      Number(
        (
          await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
            f.u,
          ])
        )[0].n,
      ),
    ).toBe(c.status === 'OPENED' ? 9900 : 10000);
  });
  it('does not sell a stock slot already reserved by a card checkout', async () => {
    const f = await fixture(1);
    const all = await Promise.allSettled([
      payments.prepare(f.u, randomUUID(), f.dto),
      orders.purchase(f.u, randomUUID(), f.dto),
    ]);
    expect(all.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });
});
