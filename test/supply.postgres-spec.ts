import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { OperationsService } from '../src/modules/operations/operations.service';
import { SupplyService } from '../src/modules/supply/supply.service';
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
describe('multi-connection physical stock races', () => {
  let ops: OperationsService, shipping: FulfillmentsService, s: SupplyService;
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
    s = new SupplyService(db, ops);
    shipping = new FulfillmentsService(db);
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  async function actor() {
    const [u] = await db.query(
      `INSERT INTO users(email,nickname) VALUES($1,'stock-race') RETURNING id,email`,
      [randomUUID() + '@example.invalid'],
    );
    await db.query(
      `INSERT INTO operations_permissions(user_id,permission) VALUES($1,'WAREHOUSE'),($1,'FULFILLMENT')`,
      [u.id],
    );
    return { userId: u.id, email: u.email, authVersion: 0 };
  }
  async function parcel() {
    const f = await conversionFixture(db.query.bind(db), 1);
    await db.query(
      `UPDATE items SET fulfillment_type='PHYSICAL',shipping_enabled=true WHERE id IN(SELECT item_id FROM inventory_items WHERE user_id=$1)`,
      [f.userId],
    );
    const [i] = await db.query(
      'SELECT p.id,p.warehouse_sku_id FROM items p JOIN inventory_items i ON i.item_id=p.id WHERE i.id=$1',
      [f.ids[0]],
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
    });
    return {
      ...f,
      skuId: i.warehouse_sku_id,
      itemId: i.id,
      ...(await shipping.create(f.userId, randomUUID(), q.quoteId)),
    };
  }
  it('allows only one order to reserve the final shared unit across distinct operators and users', async () => {
    const a = await actor(),
      b = await actor(),
      one = await parcel(),
      two = await parcel();
    await s.link(b, two.itemId, randomUUID(), {
      expectedVersion: 0,
      skuId: one.skuId,
    });
    const r = await Promise.allSettled([
      ops.dispatch(a, one.fulfillmentId, randomUUID(), {
        expectedVersion: 1,
        status: 'PREPARING',
      }),
      ops.dispatch(b, two.fulfillmentId, randomUUID(), {
        expectedVersion: 1,
        status: 'PREPARING',
      }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await s.sku(a, one.skuId)).toMatchObject({
      onHand: 1,
      reserved: 1,
      available: 0,
    });
    const rows = await db.query(
      'SELECT state FROM warehouse_allocations WHERE sku_id=$1',
      [one.skuId],
    );
    expect(rows).toEqual([{ state: 'RESERVED' }]);
  });
  it('serializes stock adjustment against reservation without a negative balance', async () => {
    const a = await actor(),
      b = await actor(),
      r = await parcel();
    const outcomes = await Promise.allSettled([
      ops.dispatch(a, r.fulfillmentId, randomUUID(), {
        expectedVersion: 1,
        status: 'PREPARING',
      }),
      s.movement(b, r.skuId, randomUUID(), {
        expectedVersion: 1,
        kind: 'ADJUST',
        quantity: -1,
        reason: 'damaged unit',
      }),
    ]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const stock = await s.sku(a, r.skuId),
      shipment = await shipping.findOne(r.userId, r.fulfillmentId);
    if (shipment.status === 'PREPARING')
      expect(stock).toMatchObject({ onHand: 1, reserved: 1 });
    else expect(stock).toMatchObject({ onHand: 0, reserved: 0 });
  });
  it('cancellation and collection settle a reservation exactly once', async () => {
    const a = await actor(),
      r = await parcel();
    await ops.dispatch(a, r.fulfillmentId, randomUUID(), {
      expectedVersion: 1,
      status: 'PREPARING',
    });
    const out = await Promise.allSettled([
      shipping.cancel(r.userId, r.fulfillmentId),
      ops.dispatch(a, r.fulfillmentId, randomUUID(), {
        expectedVersion: 2,
        status: 'COLLECTED',
        carrier: 'CJ',
        trackingNumber: 'TEST12345',
      }),
    ]);
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const stock = await s.sku(a, r.skuId),
      shipment = await shipping.findOne(r.userId, r.fulfillmentId);
    expect(stock.reserved).toBe(0);
    expect(stock.onHand).toBe(shipment.status === 'CANCELLED' ? 1 : 0);
    expect(stock.movements).toHaveLength(2);
  });
});
