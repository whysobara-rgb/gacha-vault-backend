import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { FulfillmentsService } from '../src/modules/fulfillments/fulfillments.service';
import { ConversionsService } from '../src/modules/conversions/conversions.service';
import { conversionFixture } from './helpers/conversion-fixture';
// Dedicated PostgreSQL / CI only. PGlite does not prove multi-connection row locks.
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
const recipient = {
  name: 'Test',
  phone: '01000000000',
  postalCode: '00000',
  address1: 'Test address',
  address2: '101',
  country: 'KR' as const,
};
describe('concurrent fulfillment transactions on PostgreSQL', () => {
  let service: FulfillmentsService, conversions: ConversionsService;
  const env = { ...process.env };
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated local test database required');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      ENABLE_SHIPPING_PREVIEW: 'true',
      SHIPPING_RATE_TABLE_JSON: JSON.stringify([
        { id: 'test', label: 'Test', prefixes: ['*'], feeGP: 3000 },
      ]),
      ENABLE_GP_CONVERSION_PREVIEW: 'true',
      GP_RESTORE_WINDOW_HOURS: '24',
      GP_RESTORE_MAX_PER_ITEM: '1',
    });
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    service = new FulfillmentsService(db);
    conversions = new ConversionsService(db);
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
    process.env = env;
  });
  const fixture = async () => {
    const f = await conversionFixture((s, p) => db.query(s, p), 1);
    await db.query('UPDATE users SET "coinBalance"=5000 WHERE id=$1', [
      f.userId,
    ]);
    await db.query(
      `UPDATE items SET fulfillment_type='PHYSICAL',shipping_enabled=true WHERE id IN(SELECT item_id FROM inventory_items WHERE user_id=$1)`,
      [f.userId],
    );
    return f;
  };
  const quote = (f: any) =>
    service.quote(f.userId, { inventoryItemIds: f.ids, recipient });
  it('serializes six retries into a single fee and a single cancellation refund', async () => {
    const f = await fixture(),
      q = await quote(f),
      key = randomUUID();
    const all = await Promise.all(
      Array.from({ length: 6 }, () => service.create(f.userId, key, q.quoteId)),
    );
    expect(new Set(all.map((r) => r.fulfillmentId)).size).toBe(1);
    await Promise.all(
      all.map((r) => service.cancel(f.userId, r.fulfillmentId)),
    );
    expect(
      Number(
        (
          await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
            f.userId,
          ])
        )[0].n,
      ),
    ).toBe(5000);
    expect(
      Number(
        (
          await db.query(
            "SELECT count(*) AS n FROM wallet_transactions WHERE user_id=$1 AND origin LIKE 'SHIPPING_%'",
            [f.userId],
          )
        )[0].n,
      ),
    ).toBe(2);
  });
  it('allows only one of two overlapping quotes to reserve the item', async () => {
    const f = await fixture(),
      q1 = await quote(f),
      q2 = await quote(f);
    const all = await Promise.allSettled([
      service.create(f.userId, randomUUID(), q1.quoteId),
      service.create(f.userId, randomUUID(), q2.quoteId),
    ]);
    expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await service.list(f.userId)).totalCount).toBe(1);
  });
  it('allows either conversion or shipping of the same inventory, never both', async () => {
    const f = await fixture(),
      sq = await quote(f),
      cq = await conversions.quote(f.userId, f.ids);
    const all = await Promise.allSettled([
      service.create(f.userId, randomUUID(), sq.quoteId),
      conversions.convert(f.userId, randomUUID(), {
        inventoryItemIds: f.ids,
        expectedTotalGP: cq.totalGP,
        expectedQuoteVersion: cq.quoteVersion,
      }),
    ]);
    expect(all.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [row] = await db.query(
      'SELECT status FROM inventory_items WHERE id=$1',
      [f.ids[0]],
    );
    expect(['CONVERTED', 'SHIPPING_REQUESTED']).toContain(row.status);
    expect(
      Number(
        (
          await db.query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
            f.userId,
          ])
        )[0].n,
      ),
    ).toBe(row.status === 'CONVERTED' ? 5010 : 2000);
  });
});
