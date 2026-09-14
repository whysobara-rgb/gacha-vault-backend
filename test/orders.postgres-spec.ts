import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
import {
  Item,
  InventoryItem,
  CapsuleOpening,
  GachaItem,
  Draw,
  CapsuleOrder,
  OwnedCapsule,
  User,
  Gacha,
  CurrencyType,
  WalletTransaction,
} from '../src/entities';
import { InventoryService } from '../src/modules/inventory/inventory.service';
import { GachaService } from '../src/modules/gacha/gacha.service';
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
  let prize: Item;
  let version: string;
  const env = {
    preview: process.env.ENABLE_GP_ORDER_PREVIEW,
    legacy: process.env.ENABLE_LEGACY_TRANSACTIONS,
  };
  const request = () => ({
    gachaId: gacha.id,
    quantity: 2,
    expectedUnitPrice: 100,
    expectedProbabilityVersion: version,
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
    gacha = await db.getRepository(Gacha).save({
      title: 'GP test',
      price: 100,
      currency: CurrencyType.GP,
      totalStock: 10,
    });
    prize = await db.getRepository(Item).save({
      name: 'snapshot-prize',
      estimatedValue: 1000,
      isPremium: false,
      conversionGP: 100,
    });
    await db
      .getRepository(GachaItem)
      .save({ gachaId: gacha.id, itemId: prize.id, probabilityPpm: 1000000 });
    version = (await service.odds(gacha.id)).version;
  });
  afterEach(async () => {
    if (!db.isInitialized || !users) return;
    const userIds = users.map((u) => u.id);
    const orders = await db
      .getRepository(CapsuleOrder)
      .findBy({ userId: In(userIds) });
    const inventory = await db
      .getRepository(InventoryItem)
      .findBy({ userId: In(userIds) });
    if (inventory.length) {
      await db
        .getRepository(CapsuleOpening)
        .delete({ inventoryItemId: In(inventory.map((i) => i.id)) });
      await db.getRepository(InventoryItem).delete({ userId: In(userIds) });
    }
    if (orders.length) {
      await db
        .getRepository(OwnedCapsule)
        .delete({ orderId: In(orders.map((o) => o.id)) });
      await db.getRepository(CapsuleOrder).delete({ userId: In(userIds) });
    }
    await db.getRepository(User).delete(userIds);
    await db.getRepository(Gacha).delete(gacha.id);
    await db.getRepository(Item).delete(prize.id);
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
    const catalog = new GachaService(
      db.getRepository(Gacha),
      db.getRepository(GachaItem),
      db.getRepository(Draw),
    );
    expect((await catalog.findOne(gacha.id)).soldStock).toBe(2);
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
  it('opens once under six concurrent requests and preserves purchased prize fields after catalog changes', async () => {
    const order = await service.purchase(users[0].id, randomUUID(), request());
    await db.getRepository(Item).update(prize.id, {
      name: 'changed',
      conversionGP: 999,
      isPremium: true,
    });
    const id = order.capsules[0].id;
    await expect(db.getRepository(Item).delete(prize.id)).rejects.toThrow();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.open(users[0].id, id.toUpperCase()),
      ),
    );
    expect(
      results.every((r) => r.inventoryItemId === results[0].inventoryItemId),
    ).toBe(true);
    expect(results[0].prize).toMatchObject({
      name: 'snapshot-prize',
      conversionGP: 100,
      isPremium: false,
    });
    expect(
      await db.getRepository(InventoryItem).countBy({ userId: users[0].id }),
    ).toBe(1);
    expect(await service.openingResult(users[0].id, id)).toEqual(results[0]);
    const inventoryService = new InventoryService(
      db.getRepository(InventoryItem),
    );
    const inventory = await inventoryService.findAll(users[0].id, {
      page: 1,
      limit: 20,
    });
    expect(inventory.items[0]).toMatchObject({
      name: 'snapshot-prize',
      isPremium: false,
      conversionGP: 100,
    });
    expect(
      (await service.listCapsules(users[0].id, { page: 1, limit: 20 })).items,
    ).toHaveLength(1);
    expect(await balance(users[0].id)).toBe('800');
    const catalog = new GachaService(
      db.getRepository(Gacha),
      db.getRepository(GachaItem),
      db.getRepository(Draw),
    );
    expect((await catalog.findOne(gacha.id)).soldStock).toBe(2);
  });

  it('denies opening and result recovery to another owner', async () => {
    const order = await service.purchase(users[0].id, randomUUID(), request());
    const id = order.capsules[0].id;
    await expect(service.open(users[1].id, id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.openingResult(users[0].id, id)).rejects.toMatchObject({
      status: 409,
    });
    await service.open(users[0].id, id);
    await expect(service.openingResult(users[1].id, id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects changed probability/prize quotes and invalid probability totals before debit', async () => {
    await db.getRepository(Item).update(prize.id, { name: 'new quote' });
    await expect(
      service.purchase(users[0].id, randomUUID(), request()),
    ).rejects.toMatchObject({ status: 409 });
    await db
      .getRepository(GachaItem)
      .update({ gachaId: gacha.id }, { probabilityPpm: 999999 });
    await expect(service.odds(gacha.id)).rejects.toMatchObject({ status: 409 });
    expect(await balance(users[0].id)).toBe('1000');
  });

  it('rejects order probability and opening result updates at the DB boundary', async () => {
    const order = await service.purchase(users[0].id, randomUUID(), request());
    await expect(
      db.query(
        'UPDATE capsule_orders SET probability_version = $1 WHERE id = $2',
        ['b'.repeat(64), order.orderId],
      ),
    ).rejects.toThrow('immutable');
    await service.open(users[0].id, order.capsules[0].id);
    await expect(
      db.query('UPDATE capsule_openings SET ticket = 0 WHERE capsule_id = $1', [
        order.capsules[0].id,
      ]),
    ).rejects.toThrow('immutable');
  });

  it('rolls back prize inventory if result persistence fails, then retries once', async () => {
    const order = await service.purchase(users[0].id, randomUUID(), request());
    const id = order.capsules[0].id;
    await db.query(
      `CREATE FUNCTION reject_test_opening() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test opening failure'; END $$`,
    );
    await db.query(
      'CREATE TRIGGER reject_test_opening BEFORE INSERT ON capsule_openings FOR EACH ROW EXECUTE FUNCTION reject_test_opening()',
    );
    try {
      await expect(service.open(users[0].id, id)).rejects.toThrow(
        'test opening failure',
      );
      expect(
        await db.getRepository(InventoryItem).countBy({ userId: users[0].id }),
      ).toBe(0);
      expect(
        (await db.getRepository(OwnedCapsule).findOneByOrFail({ id })).status,
      ).toBe('UNOPENED');
      expect(
        await db.getRepository(CapsuleOpening).countBy({ capsuleId: id }),
      ).toBe(0);
    } finally {
      await db.query('DROP TRIGGER reject_test_opening ON capsule_openings');
      await db.query('DROP FUNCTION reject_test_opening()');
    }
    await service.open(users[0].id, id);
    expect(
      await db.getRepository(InventoryItem).countBy({ userId: users[0].id }),
    ).toBe(1);
  });
  it('refuses legacy capsules without a purchase-time probability snapshot', async () => {
    const ledger = await db.getRepository(WalletTransaction).save({
      userId: users[0].id,
      type: 'USE' as any,
      amount: -100,
      description: 'legacy test',
      balanceAfter: 900,
    });
    const order = await db.getRepository(CapsuleOrder).save({
      id: randomUUID(),
      userId: users[0].id,
      idempotencyKey: randomUUID(),
      gachaId: gacha.id,
      titleSnapshot: 'legacy',
      unitPrice: 100,
      quantity: 1,
      total: 100,
      currency: 'GP',
      status: 'PAID',
      walletTransactionId: ledger.id,
      balanceAfter: '900',
    });
    const capsule = await db.getRepository(OwnedCapsule).save({
      id: randomUUID(),
      orderId: order.id,
      sequence: 1,
      status: 'UNOPENED',
    });
    await expect(service.open(users[0].id, capsule.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await db.getRepository(InventoryItem).countBy({ userId: users[0].id }),
    ).toBe(0);
  });
});
