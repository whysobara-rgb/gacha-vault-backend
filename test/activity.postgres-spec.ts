import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import {
  User,
  WalletTransaction,
  WalletTransactionType,
} from '../src/entities';
import { WalletService } from '../src/modules/wallet/wallet.service';

const database = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? '5432'),
  username: 'gacha_ci',
  password: 'local-ci-only',
  database: 'gacha_integration_test',
  synchronize: false,
  extra: { max: 4, statement_timeout: 10000 },
});
describe('Account activity pagination on PostgreSQL', () => {
  let userId: number;
  let otherId: number;
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test database required');
    await database.initialize();
    await database.runMigrations({ transaction: 'all' });
  });
  afterEach(async () => {
    if (!database.isInitialized) return;
    if (userId) await database.getRepository(User).delete(userId);
    if (otherId) await database.getRepository(User).delete(otherId);
  });
  afterAll(async () => {
    if (database.isInitialized) await database.destroy();
  });
  it('returns all 101 tied-time rows exactly once, filters by type and isolates owners', async () => {
    const users = database.getRepository(User);
    userId = (
      await users.save(
        users.create({
          email: `${randomUUID()}@example.invalid`,
          nickname: 'activity-owner',
        }),
      )
    ).id;
    otherId = (
      await users.save(
        users.create({
          email: `${randomUUID()}@example.invalid`,
          nickname: 'activity-other',
        }),
      )
    ).id;
    const ledger = database.getRepository(WalletTransaction);
    const sameTime = new Date('2026-09-14T00:00:00Z');
    const rows = await ledger.save(
      Array.from({ length: 101 }, () =>
        ledger.create({
          userId,
          type: WalletTransactionType.USE,
          amount: -1,
          balanceAfter: 0,
          description: 'integration-only',
          createdAt: sameTime,
        }),
      ),
    );
    await ledger.save(
      ledger.create({
        userId: otherId,
        type: WalletTransactionType.USE,
        amount: -1,
        balanceAfter: 0,
        description: 'other-account',
        createdAt: sameTime,
      }),
    );
    await ledger.save(
      ledger.create({
        userId,
        type: WalletTransactionType.EARN,
        amount: 1,
        balanceAfter: 1,
        description: 'filtered-out',
        createdAt: sameTime,
      }),
    );
    const service = new WalletService(database);
    const actual: number[] = [];
    for (let page = 1; page <= 6; page++) {
      const result = await service.getPointHistory(userId, {
        page,
        limit: 20,
        type: WalletTransactionType.USE,
      });
      expect(result.totalCount).toBe(101);
      actual.push(...result.items.map((row) => row.id));
    }
    expect(actual).toEqual(rows.map((row) => row.id).sort((a, b) => b - a));
    expect(new Set(actual).size).toBe(101);
    const other = await service.getPointHistory(otherId, {
      page: 1,
      limit: 20,
    });
    expect(other.totalCount).toBe(1);
    expect(other.items[0].description).toBe('other-account');
  });
});
