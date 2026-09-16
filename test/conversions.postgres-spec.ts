import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { ConversionsService } from '../src/modules/conversions/conversions.service';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { InventoryItem } from '../src/entities';
import { conversionFixture } from './helpers/conversion-fixture';
// Dedicated local/CI database only. Real multi-connection checks, separate from WASM.
const database = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
  username: 'gacha_ci',
  password: 'local-ci-only',
  database: 'gacha_integration_test',
  synchronize: false,
  extra: { max: 8, statement_timeout: 10000 },
});
describe('concurrent conversion and restoration on PostgreSQL', () => {
  let service: ConversionsService;
  const env = { ...process.env };
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated local test database required');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_GP_CONVERSION_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      GP_RESTORE_WINDOW_HOURS: '24',
      GP_RESTORE_MAX_PER_ITEM: '1',
    });
    await database.initialize();
    await database.runMigrations({ transaction: 'all' });
    service = new ConversionsService(database);
  });
  afterAll(async () => {
    if (database.isInitialized) await database.destroy();
    process.env = env;
  });
  it('serializes six identical requests to exactly one credit and one restore debit', async () => {
    const f = await conversionFixture((s, p) => database.query(s, p)),
      q = await service.quote(f.userId, f.ids),
      key = randomUUID(),
      dto = {
        inventoryItemIds: f.ids,
        expectedTotalGP: q.totalGP,
        expectedQuoteVersion: q.quoteVersion,
      };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.convert(f.userId, key, dto)),
    );
    expect(new Set(results.map((r) => r.conversionId)).size).toBe(1);
    await Promise.all(
      Array.from({ length: 6 }, () =>
        service.restore(f.userId, results[0].conversionId),
      ),
    );
    expect(
      Number(
        (
          await database.query(
            'SELECT "coinBalance" AS n FROM users WHERE id=$1',
            [f.userId],
          )
        )[0].n,
      ),
    ).toBe(900);
    expect(
      Number(
        (
          await database.query(
            "SELECT count(*) AS n FROM wallet_transactions WHERE user_id=$1 AND origin<>'LEGACY'",
            [f.userId],
          )
        )[0].n,
      ),
    ).toBe(2);
  });
  it('accepts only one of two different conversion keys on the same inventory', async () => {
    const f = await conversionFixture((s, p) => database.query(s, p), 1),
      q = await service.quote(f.userId, f.ids),
      dto = {
        inventoryItemIds: f.ids,
        expectedTotalGP: q.totalGP,
        expectedQuoteVersion: q.quoteVersion,
      };
    const r = await Promise.allSettled([
      service.convert(f.userId, randomUUID(), dto),
      service.convert(f.userId, randomUUID(), dto),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(
      Number(
        (
          await database.query(
            'SELECT "coinBalance" AS n FROM users WHERE id=$1',
            [f.userId],
          )
        )[0].n,
      ),
    ).toBe(910);
  });
  it('rechecks the committed lock state after a competing transaction', async () => {
    const f = await conversionFixture((s, p) => database.query(s, p), 1),
      q = await service.quote(f.userId, f.ids),
      runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        'SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE',
        [f.ids[0]],
      );
      const pending = service
        .convert(f.userId, randomUUID(), {
          inventoryItemIds: f.ids,
          expectedTotalGP: q.totalGP,
          expectedQuoteVersion: q.quoteVersion,
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await runner.query(
        'UPDATE inventory_items SET "isLocked"=true WHERE id=$1',
        [f.ids[0]],
      );
      await runner.commitTransaction();
      expect(await pending).toMatchObject({ error: { status: 409 } });
      const lock = new InventoryService(database.getRepository(InventoryItem));
      await lock.setLock(f.userId, f.ids[0], false);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
