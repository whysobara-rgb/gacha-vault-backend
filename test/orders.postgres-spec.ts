import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import {
  CapsuleOrder,
  OwnedCapsule,
  User,
  Gacha,
  CurrencyType,
  WalletTransaction,
} from '../src/entities';
import { OrdersService } from '../src/modules/orders/orders.service';

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

describe('GP orders against PostgreSQL', () => {
  let service: OrdersService;
  let users: User[];
  let gacha: Gacha;
  const env = {
    preview: process.env.ENABLE_GP_ORDER_PREVIEW,
    legacy: process.env.ENABLE_LEGACY_TRANSACTIONS,
  };
  const request = () => ({
    gachaId: gacha.id,
    quantity: 2,
    expectedUnitPrice: 100,
  });
  const balance = async (id: number) =>
    String((await db.getRepository(User).findOneByOrFail({ id })).coinBalance);
  beforeAll(async () => {
    if (process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated test DB opt-in required');
    await db.initialize();
    await db.runMigrations({ transaction: 'all' });
    service = new OrdersService(db);
  });
  beforeEach(async () => {
    process.env.ENABLE_GP_ORDER_PREVIEW = 'true';
    delete process.env.ENABLE_LEGACY_TRANSACTIONS;
    users = await db.getRepository(User).save(
      [0, 1].map(() => ({
        email: `${randomUUID()}@example.invalid`,
        nickname: 'order-test',
        coinBalance: 1000,
      })),
    );
    gacha = await db
      .getRepository(Gacha)
      .save({
        title: 'GP test',
        price: 100,
        currency: CurrencyType.GP,
        totalStock: 10,
      });
  });
  afterEach(async () => {
    if (!db.isInitialized || !users) return;
    const userIds = users.map((u) => u.id);
    const orders = await db
      .getRepository(CapsuleOrder)
      .findBy({ userId: In(userIds) });
    if (orders.length) {
      await db
        .getRepository(OwnedCapsule)
        .delete({ orderId: In(orders.map((o) => o.id)) });
      await db.getRepository(CapsuleOrder).delete({ userId: In(userIds) });
    }
    await db.getRepository(User).delete(userIds);
    await db.getRepository(Gacha).delete(gacha.id);
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries({
      ENABLE_GP_ORDER_PREVIEW: env.preview,
      ENABLE_LEGACY_TRANSACTIONS: env.legacy,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (db.isInitialized) await db.destroy();
  });

  it('atomically records a paid order, one debit and separate unopened capsules', async () => {
    const result = await service.purchase(users[0].id, randomUUID(), request());
    expect(result).toMatchObject({
      total: 200,
      balanceAfter: '800',
      status: 'PAID',
    });
    expect(result.capsules).toHaveLength(2);
    expect(result.capsules.every((c) => c.status === 'UNOPENED')).toBe(true);
    expect(await balance(users[0].id)).toBe('800');
    const ledger = await db
      .getRepository(WalletTransaction)
      .findBy({ userId: users[0].id });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe(-200);
  });

  it('returns the same receipt for six concurrent retries, even after a price change', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.purchase(users[0].id, key, request()),
      ),
    );
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(await balance(users[0].id)).toBe('800');
    expect(
      await db
        .getRepository(WalletTransaction)
        .countBy({ userId: users[0].id }),
    ).toBe(1);
    await db
      .getRepository(Gacha)
      .update(gacha.id, { price: 200, active: false });
    expect(
      await service.purchase(users[0].id, key.toUpperCase(), request()),
    ).toEqual(results[0]);
  });

  it('rejects reuse of a request key with a different quantity', async () => {
    const key = randomUUID();
    await service.purchase(users[0].id, key, request());
    await expect(
      service.purchase(users[0].id, key, { ...request(), quantity: 3 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance(users[0].id)).toBe('800');
  });

  it('allows the same key for different owners and isolates order/capsule reads', async () => {
    const key = randomUUID();
    const first = await service.purchase(users[0].id, key, request());
    const second = await service.purchase(users[1].id, key, request());
    expect(first.orderId).not.toBe(second.orderId);
    await expect(
      service.findOne(users[1].id, first.orderId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await service.listCapsules(users[0].id, { page: 1, limit: 20 })
      ).items.map((c) => c.orderId),
    ).toEqual([first.orderId, first.orderId]);
  });

  it('rejects a stale quote without creating any order or ledger entry', async () => {
    await expect(
      service.purchase(users[0].id, randomUUID(), {
        ...request(),
        expectedUnitPrice: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance(users[0].id)).toBe('1000');
    expect(
      await db.getRepository(CapsuleOrder).countBy({ userId: users[0].id }),
    ).toBe(0);
    expect(
      await db
        .getRepository(WalletTransaction)
        .countBy({ userId: users[0].id }),
    ).toBe(0);
  });

  it('prevents concurrent overspending by the same user with different request keys', async () => {
    await db.getRepository(User).update(users[0].id, { coinBalance: 300 });
    const results = await Promise.allSettled(
      [0, 1].map(() => service.purchase(users[0].id, randomUUID(), request())),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(users[0].id)).toBe('100');
  });

  it('prevents two users from buying the same remaining stock', async () => {
    await db.getRepository(Gacha).update(gacha.id, { totalStock: 2 });
    const results = await Promise.allSettled(
      users.map((u) => service.purchase(u.id, randomUUID(), request())),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.getRepository(CapsuleOrder).countBy({ gachaId: gacha.id }),
    ).toBe(1);
    expect(
      [await balance(users[0].id), await balance(users[1].id)].sort(),
    ).toEqual(['1000', '800']);
  });

  it('rolls back balance, ledger and order when capsule issuance fails, then permits retry', async () => {
    await db.query(
      `CREATE FUNCTION reject_test_capsule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test issuance failure'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER reject_test_capsule BEFORE INSERT ON owned_capsules FOR EACH ROW WHEN (NEW.sequence = 2) EXECUTE FUNCTION reject_test_capsule()`,
    );
    const key = randomUUID();
    try {
      await expect(
        service.purchase(users[0].id, key, request()),
      ).rejects.toThrow('test issuance failure');
      expect(await balance(users[0].id)).toBe('1000');
      expect(
        await db.getRepository(CapsuleOrder).countBy({ userId: users[0].id }),
      ).toBe(0);
      expect(
        await db
          .getRepository(WalletTransaction)
          .countBy({ userId: users[0].id }),
      ).toBe(0);
    } finally {
      await db.query('DROP TRIGGER reject_test_capsule ON owned_capsules');
      await db.query('DROP FUNCTION reject_test_capsule()');
    }
    expect(
      (await service.purchase(users[0].id, key, request())).capsules,
    ).toHaveLength(2);
  });

  it('rejects non-GP products and unavailable stock', async () => {
    await db
      .getRepository(Gacha)
      .update(gacha.id, { currency: CurrencyType.COIN });
    await expect(
      service.purchase(users[0].id, randomUUID(), request()),
    ).rejects.toMatchObject({ status: 409 });
    await db
      .getRepository(Gacha)
      .update(gacha.id, { currency: CurrencyType.GP, totalStock: 0 });
    await expect(
      service.purchase(users[0].id, randomUUID(), request()),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance(users[0].id)).toBe('1000');
  });
});
