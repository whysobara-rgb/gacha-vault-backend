import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import {
  Gacha,
  GachaItem,
  Item,
  User,
  WalletTransaction,
} from '../src/entities';
import {
  FIXTURE_TITLE,
  FIXTURE_GRANT,
  preparePreviewFixture,
} from '../src/database/seeds/preview-fixture';

const db = new DataSource({
  ...dataSourceOptions,
  host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? '5432'),
  username: 'gacha_ci',
  password: 'local-ci-only',
  database: 'gacha_integration_test',
  synchronize: false,
  extra: { max: 8, statement_timeout: 10000 },
});

describe('preview fixture against PostgreSQL', () => {
  let user: User;
  const env = () => ({
    NODE_ENV: 'test',
    ENABLE_TEST_FIXTURES: 'true',
    ENABLE_GP_ORDER_PREVIEW: 'true',
    TEST_FIXTURE_EMAIL: user.email,
  });
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test DB opt-in required');
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
  });
  beforeEach(async () => {
    user = await db
      .getRepository(User)
      .save({
        email: `${randomUUID()}@example.invalid`,
        nickname: 'fixture-test',
        coinBalance: 123,
      });
  });
  afterEach(async () => {
    if (!db.isInitialized) return;
    const boxes = await db
      .getRepository(Gacha)
      .findBy({ title: FIXTURE_TITLE });
    for (const box of boxes) {
      const pool = await db
        .getRepository(GachaItem)
        .findBy({ gachaId: box.id });
      await db.getRepository(Gacha).delete(box.id);
      for (const row of pool) await db.getRepository(Item).delete(row.itemId);
    }
    if (user) await db.getRepository(User).delete(user.id);
  });
  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
  });
  it('concurrent runs create one box and exactly one additive ledger grant', async () => {
    const results = await Promise.all([
      preparePreviewFixture(db, env()),
      preparePreviewFixture(db, env()),
    ]);
    expect(results.filter((r) => r.granted)).toHaveLength(1);
    expect(results[0].gachaId).toBe(results[1].gachaId);
    expect(
      (await db.getRepository(User).findOneByOrFail({ id: user.id }))
        .coinBalance,
    ).toBe('10123');
    expect(
      await db
        .getRepository(WalletTransaction)
        .countBy({ userId: user.id, description: FIXTURE_GRANT }),
    ).toBe(1);
    const pool = await db
      .getRepository(GachaItem)
      .findBy({ gachaId: results[0].gachaId });
    expect(pool.map((p) => p.probabilityPpm).sort((a, b) => a - b)).toEqual([
      100000, 900000,
    ]);
  });
  it('missing registered account leaves no box or credit behind', async () => {
    await expect(
      preparePreviewFixture(db, {
        ...env(),
        TEST_FIXTURE_EMAIL: 'missing@example.invalid',
      }),
    ).rejects.toThrow('Register');
    expect(
      await db.getRepository(Gacha).countBy({ title: FIXTURE_TITLE }),
    ).toBe(0);
  });
  it('does not refill a spent balance on restart', async () => {
    await preparePreviewFixture(db, env());
    await db.getRepository(User).update(user.id, { coinBalance: 23 });
    expect((await preparePreviewFixture(db, env())).granted).toBe(false);
    expect(
      (await db.getRepository(User).findOneByOrFail({ id: user.id }))
        .coinBalance,
    ).toBe('23');
  });
  it('rejects changed odds without repairing or granting again', async () => {
    const result = await preparePreviewFixture(db, env());
    const pool = await db
      .getRepository(GachaItem)
      .findBy({ gachaId: result.gachaId });
    await db.getRepository(GachaItem).update(pool[0].id, { probabilityPpm: 1 });
    await expect(preparePreviewFixture(db, env())).rejects.toThrow('modified');
    expect(
      (await db.getRepository(GachaItem).findOneByOrFail({ id: pool[0].id }))
        .probabilityPpm,
    ).toBe(1);
    expect(
      await db.getRepository(WalletTransaction).countBy({ userId: user.id }),
    ).toBe(1);
  });
  it('rolls back new prizes and box if balance validation fails', async () => {
    await db.getRepository(User).update(user.id, { coinBalance: -1 });
    const itemsBefore = await db.getRepository(Item).count();
    await expect(preparePreviewFixture(db, env())).rejects.toThrow('balance');
    expect(
      await db.getRepository(Gacha).countBy({ title: FIXTURE_TITLE }),
    ).toBe(0);
    expect(await db.getRepository(Item).count()).toBe(itemsBefore);
  });
});
