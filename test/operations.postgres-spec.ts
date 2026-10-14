import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { OperationsService } from '../src/modules/operations/operations.service';
import { CatalogConfig } from '../src/modules/operations/operations.policy';
import { FulfillmentsService } from '../src/modules/fulfillments/fulfillments.service';
import { conversionFixture } from './helpers/conversion-fixture';
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
const config: CatalogConfig = {
  title: 'Concurrent catalog',
  description: 'test',
  imageUrl: null,
  price: 100,
  totalStock: 100,
  saleType: 'STANDARD',
  entries: [
    {
      name: 'test',
      rarity: 'N',
      imageUrl: null,
      estimatedValue: 100,
      isPremium: false,
      probabilityPpm: 1000000,
      fulfillmentType: 'PHYSICAL',
      shippingEnabled: true,
    },
  ],
};
describe('multi-connection catalog and dispatch races', () => {
  let ops: OperationsService, shipping: FulfillmentsService;
  const env = { ...process.env };
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test DB required');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_OPERATIONS_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      ENABLE_SHIPPING_PREVIEW: 'true',
      SHIPPING_RATE_TABLE_JSON: JSON.stringify([
        { id: 'test', label: 'test', prefixes: ['*'], feeGP: 100 },
      ]),
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    ops = new OperationsService(db);
    shipping = new FulfillmentsService(db);
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  async function actor() {
    const [u] = await db.query(
      `INSERT INTO users(email,nickname) VALUES($1,'ops-race') RETURNING id,email`,
      [randomUUID() + '@example.invalid'],
    );
    await db.query(
      `INSERT INTO operations_permissions(user_id,permission) VALUES($1,'CATALOG'),($1,'FULFILLMENT')`,
      [u.id],
    );
    return { userId: u.id, email: u.email, authVersion: 0 };
  }
  it('creates one draft across six retries', async () => {
    const a = await actor(),
      key = randomUUID(),
      r = await Promise.all(
        Array.from({ length: 6 }, () => ops.create(a, key, config)),
      );
    expect(new Set(r.map((x) => x.gachaId)).size).toBe(1);
    expect((await ops.catalogDetail(a, r[0].gachaId)).version).toBe(1);
  });
  it('allows only one of two operators to replace the same draft version', async () => {
    const a = await actor(),
      b = await actor(),
      d = await ops.create(a, randomUUID(), config);
    const r = await Promise.allSettled([
      ops.save(a, d.gachaId, randomUUID(), {
        expectedVersion: 1,
        config: { ...config, price: 200 },
      }),
      ops.save(b, d.gachaId, randomUUID(), {
        expectedVersion: 1,
        config: { ...config, price: 300 },
      }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await ops.catalogDetail(a, d.gachaId)).version).toBe(2);
  });
  it('serializes cancellation versus collection without shipping refunded inventory', async () => {
    const a = await actor(),
      f = await conversionFixture(db.query.bind(db), 2);
    await db.query(
      `UPDATE items SET fulfillment_type='PHYSICAL',shipping_enabled=true WHERE id IN(SELECT item_id FROM inventory_items WHERE user_id=$1)`,
      [f.userId],
    );
    const q = await shipping.quote(f.userId, {
        inventoryItemIds: f.ids,
        recipient: {
          name: 'test',
          phone: '01000000000',
          postalCode: '00000',
          address1: 'test address',
          address2: '1',
          notes: '',
          country: 'KR',
        },
      }),
      r = await shipping.create(f.userId, randomUUID(), q.quoteId);
    await ops.dispatch(a, r.fulfillmentId, randomUUID(), {
      expectedVersion: 1,
      status: 'PREPARING',
    });
    const outcomes = await Promise.allSettled([
      shipping.cancel(f.userId, r.fulfillmentId),
      ops.dispatch(a, r.fulfillmentId, randomUUID(), {
        expectedVersion: 2,
        status: 'COLLECTED',
        carrier: 'CJ',
        trackingNumber: 'TEST123456',
      }),
    ]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const done = await shipping.findOne(f.userId, r.fulfillmentId),
      [u] = await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
        f.userId,
      ]),
      items = await db.query(
        'SELECT status FROM inventory_items WHERE user_id=$1',
        [f.userId],
      );
    if (done.status === 'CANCELLED') {
      expect(Number(u.n)).toBe(900);
      expect(items.every((i) => i.status === 'STORED')).toBe(true);
    } else {
      expect(done.status).toBe('COLLECTED');
      expect(Number(u.n)).toBe(800);
      expect(items.every((i) => i.status === 'SHIPPING')).toBe(true);
    }
  });
});
