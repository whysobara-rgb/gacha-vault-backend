import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import { InventoryItem, InventoryStatus, Item, User } from '../src/entities';
import { InventoryService } from '../src/modules/inventory/inventory.service';

// Deliberately never read DB_* or dotenv: this suite can only use a dedicated
// loopback test database, with credentials unrelated to application secrets.
const database = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? '5432'),
  username: 'gacha_ci',
  password: 'local-ci-only',
  database: 'gacha_integration_test',
  synchronize: false,
  extra: { max: 8, statement_timeout: 10000 },
});

describe('Inventory lock against PostgreSQL migrations', () => {
  let service: InventoryService;
  let userId: number;
  let otherUserId: number;
  let itemId: number;
  let inventoryId: number;

  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true') {
      throw new Error(
        'Set TEST_POSTGRES=true to use the dedicated local test DB',
      );
    }
    await database.initialize();
    await database.runMigrations({ transaction: 'all' });
    service = new InventoryService(database.getRepository(InventoryItem));
  });

  beforeEach(async () => {
    const users = database.getRepository(User);
    userId = (
      await users.save(
        users.create({
          email: `${randomUUID()}@example.invalid`,
          nickname: 'integration-owner',
        }),
      )
    ).id;
    otherUserId = (
      await users.save(
        users.create({
          email: `${randomUUID()}@example.invalid`,
          nickname: 'integration-other',
        }),
      )
    ).id;
    const items = database.getRepository(Item);
    itemId = (await items.save(items.create({ name: 'integration-prize' }))).id;
    const inventory = database.getRepository(InventoryItem);
    inventoryId = (await inventory.save(inventory.create({ userId, itemId })))
      .id;
  });

  afterEach(async () => {
    if (!database.isInitialized) return;
    // Delete only fixtures belonging to this test, never truncate shared tables.
    if (userId) await database.getRepository(User).delete(userId);
    if (otherUserId) await database.getRepository(User).delete(otherUserId);
    if (itemId) await database.getRepository(Item).delete(itemId);
  });
  afterAll(async () => {
    if (database.isInitialized) await database.destroy();
  });

  it('applies the four existing migrations and reruns without changes', async () => {
    expect(await database.query('SELECT * FROM migrations')).toHaveLength(4);
    expect(await database.runMigrations()).toEqual([]);
  });

  it('persists explicit lock and unlock through real database reads', async () => {
    await service.setLock(userId, inventoryId, true);
    await service.setLock(userId, inventoryId, true);
    expect(
      (
        await database.getRepository(InventoryItem).findOneByOrFail({
          id: inventoryId,
        })
      ).isLocked,
    ).toBe(true);
    await service.setLock(userId, inventoryId, false);
    expect(
      (
        await database.getRepository(InventoryItem).findOneByOrFail({
          id: inventoryId,
        })
      ).isLocked,
    ).toBe(false);
  });

  it('rejects another owner without modifying the existing row', async () => {
    await expect(
      service.setLock(otherUserId, inventoryId, true),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await database.getRepository(InventoryItem).findOneByOrFail({
          id: inventoryId,
        })
      ).isLocked,
    ).toBe(false);
  });

  it('serializes concurrent repeated PUTs without toggling the result', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.setLock(userId, inventoryId, true),
      ),
    );
    expect(results.every((result) => result.isLocked)).toBe(true);
    expect(
      (
        await database.getRepository(InventoryItem).findOneByOrFail({
          id: inventoryId,
        })
      ).isLocked,
    ).toBe(true);
  });

  it('waits for a competing row lock and rechecks the committed shipping status', async () => {
    const runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let pending: Promise<unknown> | undefined;
    try {
      const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid');
      await runner.manager
        .getRepository(InventoryItem)
        .createQueryBuilder('inventory')
        .setLock('pessimistic_write')
        .where('inventory.id = :id', { id: inventoryId })
        .getOneOrFail();
      // Capture rejection immediately so the test never leaks an unhandled promise.
      pending = service.setLock(userId, inventoryId, true).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await database.query(
          'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [pid],
        );
        if (rows.length > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      await runner.manager.getRepository(InventoryItem).update(inventoryId, {
        status: InventoryStatus.SHIPPING_REQUESTED,
      });
      await runner.commitTransaction();
      expect(await pending).toMatchObject({ error: { status: 409 } });
      const row = await database
        .getRepository(InventoryItem)
        .findOneByOrFail({ id: inventoryId });
      expect(row.status).toBe(InventoryStatus.SHIPPING_REQUESTED);
      expect(row.isLocked).toBe(false);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      if (pending) await pending;
    }
  });
});
