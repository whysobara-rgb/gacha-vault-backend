import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { OperationsService } from '../src/modules/operations/operations.service';
import { OwnerService } from '../src/modules/owner/owner.service';
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
describe('owner procurement and campaign concurrent writes', () => {
  let s: OwnerService;
  const env = { ...process.env };
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test DB required');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_OPERATIONS_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    s = new OwnerService(db, new OperationsService(db));
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  async function actor() {
    const [u] = await db.query(
      "INSERT INTO users(email,nickname) VALUES($1,'owner-race') RETURNING id,email",
      [randomUUID() + '@example.invalid'],
    );
    await db.query(
      "INSERT INTO operations_permissions(user_id,permission) VALUES($1,'OWNER')",
      [u.id],
    );
    return { userId: u.id, email: u.email, authVersion: 0 };
  }
  async function plan(a: Awaited<ReturnType<typeof actor>>) {
    const [sku] = await db.query(
      'INSERT INTO warehouse_skus(code,name) VALUES($1,$2) RETURNING id',
      [randomUUID(), 'Test physical SKU'],
    );
    const p = await s.createProcurement(a, randomUUID(), {
      skuId: sku.id,
      supplier: 'Test',
      reference: 'External test reference',
      quantity: 5,
      unitCostKRW: 100,
      expectedAt: new Date(Date.now() + 86400000).toISOString(),
    });
    await s.changeProcurement(a, p.id, randomUUID(), {
      expectedVersion: 1,
      action: 'ORDERED',
      reason: 'External order checked',
      confirmed: true,
    });
    return { id: p.id, skuId: sku.id };
  }
  it('retries one receipt across six connections without adding stock twice', async () => {
    const a = await actor(),
      p = await plan(a),
      k = randomUUID(),
      d = {
        expectedVersion: 2,
        action: 'RECEIVE',
        quantity: 5,
        reason: 'Inspected five',
        confirmed: true,
      };
    const r = await Promise.all(
      Array.from({ length: 6 }, () => s.changeProcurement(a, p.id, k, d)),
    );
    expect(new Set(r.map((x) => x.version)).size).toBe(1);
    const [sku] = await db.query(
      'SELECT on_hand FROM warehouse_skus WHERE id=$1',
      [p.skuId],
    );
    expect(sku.on_hand).toBe(5);
    expect(
      await db.query(
        "SELECT id FROM warehouse_movements WHERE sku_id=$1 AND kind='RECEIVE'",
        [p.skuId],
      ),
    ).toHaveLength(1);
  });
  it('allows one of two owners to receive the same outstanding stock version', async () => {
    const a = await actor(),
      b = await actor(),
      p = await plan(a),
      d = {
        expectedVersion: 2,
        action: 'RECEIVE',
        quantity: 3,
        reason: 'Inspected three',
        confirmed: true,
      };
    const r = await Promise.allSettled([
      s.changeProcurement(a, p.id, randomUUID(), d),
      s.changeProcurement(b, p.id, randomUUID(), d),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const [row] = await db.query(
      'SELECT received,version FROM supplier_orders WHERE id=$1',
      [p.id],
    );
    expect(row).toEqual({ received: 3, version: 3 });
    const [sku] = await db.query(
      'SELECT on_hand FROM warehouse_skus WHERE id=$1',
      [p.skuId],
    );
    expect(sku.on_hand).toBe(3);
  });
  it('serializes two reviewed changes to one campaign version', async () => {
    const a = await actor(),
      b = await actor(),
      c = {
        title: 'Test notice',
        body: 'Real terms',
        kind: 'NOTICE',
        gachaId: null,
        startsAt: new Date(Date.now() - 1000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        budgetKRW: 0,
      },
      r = await s.saveCampaign(a, null, randomUUID(), c);
    const results = await Promise.allSettled([
      s.campaignState(a, r.id, randomUUID(), {
        expectedVersion: 1,
        status: 'PUBLISHED',
        confirmed: true,
      }),
      s.saveCampaign(b, r.id, randomUUID(), {
        ...c,
        title: 'Updated notice',
        expectedVersion: 1,
      }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const [row] = await db.query(
      'SELECT version FROM owner_campaigns WHERE id=$1',
      [r.id],
    );
    expect(row.version).toBe(2);
  });
});
