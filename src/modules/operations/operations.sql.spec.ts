import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { OperationsService } from './operations.service';
import { CatalogConfig, catalogConfig } from './operations.policy';
import { FulfillmentsService } from '../fulfillments/fulfillments.service';
import { conversionFixture } from '../../../test/helpers/conversion-fixture';
import { loadProbability } from '../orders/probability';
const config = (): CatalogConfig => ({
  title: '운영 테스트 박스',
  description: '예시 상품',
  imageUrl: null,
  price: 100,
  totalStock: 100,
  saleType: 'STANDARD',
  entries: [
    {
      name: '상품 A',
      rarity: 'N',
      imageUrl: null,
      estimatedValue: 100,
      isPremium: false,
      probabilityPpm: 700000,
      fulfillmentType: 'PHYSICAL',
      shippingEnabled: true,
    },
    {
      name: '상품 S',
      rarity: 'SSR',
      imageUrl: null,
      estimatedValue: 1000,
      isPremium: true,
      probabilityPpm: 300000,
      fulfillmentType: 'PHYSICAL',
      shippingEnabled: true,
    },
  ],
});
describe('catalog publishing and dispatch SQL lifecycle', () => {
  let db: PGlite, s: OperationsService, shipping: FulfillmentsService;
  const env = { ...process.env };
  const query = async (sql: string, p: any[] = []) =>
    (await db.query(sql, p)).rows as any[];
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_OPERATIONS_PREVIEW: 'true',
      ENABLE_SHIPPING_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      SHIPPING_RATE_TABLE_JSON: JSON.stringify([
        { id: 'test', label: 'Test', prefixes: ['*'], feeGP: 100 },
      ]),
    });
    db = new PGlite();
    await db.waitReady;
    for (const f of readdirSync(join(__dirname, '../../database/migrations'))
      .filter((f) => f.endsWith('.ts'))
      .sort()) {
      const Cls: any = Object.values(
        require('../../database/migrations/' + f),
      )[0];
      await db.transaction((tx) =>
        new Cls().up({
          query: async (sql, p) => (await tx.query(sql, p)).rows,
        }),
      );
    }
    const adapter = {
      query,
      manager: { query },
      transaction: async (...args: any[]) =>
        db.transaction((tx) =>
          args.at(-1)({
            query: async (sql, p) => (await tx.query(sql, p)).rows,
          }),
        ),
    } as unknown as DataSource;
    s = new OperationsService(adapter);
    shipping = new FulfillmentsService(adapter);
  }, 30000);
  afterAll(async () => {
    await db?.close();
    process.env = env;
  });
  async function actor(permissions = ['CATALOG', 'FULFILLMENT']) {
    const [u] = await query(
      `INSERT INTO users(email,nickname) VALUES($1,'operator') RETURNING id,email`,
      [randomUUID() + '@example.invalid'],
    );
    for (const p of permissions)
      await query(
        'INSERT INTO operations_permissions(user_id,permission) VALUES($1,$2)',
        [u.id, p],
      );
    return { userId: u.id, email: u.email, authVersion: 0 };
  }
  async function box(u: any) {
    const d = await s.create(u, randomUUID(), config());
    return s.publish(u, d.gachaId, randomUUID(), {
      expectedVersion: d.version,
      confirmation: '판매 설정 적용',
    });
  }
  async function parcel() {
    const f = await conversionFixture(query, 2);
    await query(
      `UPDATE items SET fulfillment_type='PHYSICAL',shipping_enabled=true WHERE id IN(SELECT item_id FROM inventory_items WHERE user_id=$1)`,
      [f.userId],
    );
    const q = await shipping.quote(f.userId, {
      inventoryItemIds: f.ids,
      recipient: {
        name: 'Test',
        phone: '01000000000',
        postalCode: '00000',
        address1: 'Test address',
        address2: '1',
        notes: '',
        country: 'KR',
      },
    });
    const r = await shipping.create(f.userId, randomUUID(), q.quoteId);
    return { ...f, ...r };
  }
  it('requires a separate active permission and current session for every operator action', async () => {
    const u = await actor([]);
    await query('INSERT INTO support_staff(user_id) VALUES($1)', [u.userId]);
    await expect(s.create(u, randomUUID(), config())).rejects.toMatchObject({
      status: 403,
    });
    await expect(s.shipments(u, { page: 1, limit: 20 })).rejects.toMatchObject({
      status: 403,
    });
    const a = await actor();
    await query('UPDATE users SET auth_version=1 WHERE id=$1', [a.userId]);
    await expect(s.create(a, randomUUID(), config())).rejects.toMatchObject({
      status: 401,
    });
  });
  it('creates one inactive draft and binds the request to its original payload', async () => {
    const u = await actor(),
      key = randomUUID(),
      d = await s.create(u, key, config());
    expect(await s.create(u, key, config())).toEqual(d);
    expect((await s.catalogDetail(u, d.gachaId)).active).toBe(false);
    await expect(
      s.create(u, key, { ...config(), price: 200 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await s.byRequest(u, key)).toEqual(d);
    await query(
      'UPDATE operations_permissions SET active=false WHERE user_id=$1',
      [u.userId],
    );
    await expect(s.byRequest(u, key)).rejects.toMatchObject({ status: 403 });
  });
  it('requires an exact absolute probability total before publication or sale', async () => {
    const u = await actor(),
      c = config();
    c.entries[0].probabilityPpm = 600000;
    const d = await s.create(u, randomUUID(), c);
    await expect(
      s.publish(u, d.gachaId, randomUUID(), {
        expectedVersion: 1,
        confirmation: '판매 설정 적용',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.availability(u, d.gachaId, randomUUID(), {
        expectedVersion: 1,
        active: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await query('SELECT * FROM gacha_items WHERE gacha_id=$1', [d.gachaId]))
        .length,
    ).toBe(0);
    const saved = await s.save(u, d.gachaId, randomUUID(), {
      expectedVersion: 1,
      config: config(),
    });
    const p = await s.publish(u, d.gachaId, randomUUID(), {
      expectedVersion: saved.version,
      confirmation: '판매 설정 적용',
    });
    await s.availability(u, d.gachaId, randomUUID(), {
      expectedVersion: p.version,
      active: true,
    });
    const odds = await loadProbability({ query } as any, d.gachaId);
    expect(odds.snapshot.entries.map((e) => e.probabilityPpm)).toEqual([
      700000, 300000,
    ]);
    expect(odds.snapshot.entries.map((e) => e.conversionGP)).toEqual([
      10, 1000,
    ]);
  });
  it('preserves purchased snapshots and old item references when publishing new prizes', async () => {
    const u = await actor(),
      d = await box(u),
      p = await loadProbability({ query } as any, d.gachaId),
      customer = await actor([]);
    const [w] = await query(
      `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",description) VALUES($1,'USE',-100,900,'fixture') RETURNING id`,
      [customer.userId],
    );
    const o = { id: randomUUID() };
    await query(
      `INSERT INTO capsule_orders(id,user_id,idempotency_key,gacha_id,title_snapshot,unit_price,quantity,total,currency,status,wallet_transaction_id,balance_after,probability_snapshot,probability_version) VALUES($1,$2,$3,$4,'구매 당시',100,1,100,'GP','PAID',$5,900,$6,$7)`,
      [
        o.id,
        customer.userId,
        randomUUID(),
        d.gachaId,
        w.id,
        JSON.stringify(p.snapshot),
        p.version,
      ],
    );
    await query(
      `INSERT INTO owned_capsules(id,order_id,sequence,status) VALUES($1,$2,1,'UNOPENED')`,
      [randomUUID(), o.id],
    );
    await query('INSERT INTO inventory_items(user_id,item_id) VALUES($1,$2)', [
      customer.userId,
      p.snapshot.entries[0].itemId,
    ]);
    const next = config();
    next.entries[0].name = '새 상품';
    next.entries[0].probabilityPpm = 800000;
    next.entries[1].probabilityPpm = 200000;
    const saved = await s.save(u, d.gachaId, randomUUID(), {
      expectedVersion: d.version,
      config: next,
    });
    await s.publish(u, d.gachaId, randomUUID(), {
      expectedVersion: saved.version,
      confirmation: '판매 설정 적용',
    });
    expect(
      (
        await query(
          'SELECT probability_snapshot FROM capsule_orders WHERE id=$1',
          [o.id],
        )
      )[0].probability_snapshot,
    ).toEqual(p.snapshot);
    expect(
      (
        await query('SELECT name FROM items WHERE id=$1', [
          p.snapshot.entries[0].itemId,
        ])
      )[0].name,
    ).toBe('상품 A');
    expect(
      (await loadProbability({ query } as any, d.gachaId)).version,
    ).not.toBe(p.version);
  });
  it('rejects stale draft versions and stock below committed sales', async () => {
    const u = await actor(),
      d = await box(u),
      f = await conversionFixture(query, 2);
    await query('UPDATE capsule_orders SET gacha_id=$1 WHERE user_id=$2', [
      d.gachaId,
      f.userId,
    ]);
    const saved = await s.save(u, d.gachaId, randomUUID(), {
      expectedVersion: d.version,
      config: { ...config(), totalStock: 1 },
    });
    await expect(
      s.save(u, d.gachaId, randomUUID(), {
        expectedVersion: d.version,
        config: config(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.publish(u, d.gachaId, randomUUID(), {
        expectedVersion: saved.version,
        confirmation: '판매 설정 적용',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await s.catalogDetail(u, d.gachaId)).totalStock).toBe(100);
  });
  it('rolls back pool changes and audit writes on a failed publish', async () => {
    const u = await actor(),
      d = await box(u),
      saved = await s.save(u, d.gachaId, randomUUID(), {
        expectedVersion: d.version,
        config: config(),
      }),
      before = await loadProbability({ query } as any, d.gachaId);
    await query(
      `CREATE FUNCTION reject_ops_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='PUBLISHED' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`,
    );
    await query(
      'CREATE TRIGGER reject_ops_publish BEFORE INSERT ON operations_events FOR EACH ROW EXECUTE FUNCTION reject_ops_publish()',
    );
    try {
      await expect(
        s.publish(u, d.gachaId, randomUUID(), {
          expectedVersion: saved.version,
          confirmation: '판매 설정 적용',
        }),
      ).rejects.toThrow();
    } finally {
      await query('DROP TRIGGER reject_ops_publish ON operations_events');
      await query('DROP FUNCTION reject_ops_publish()');
    }
    expect(await loadProbability({ query } as any, d.gachaId)).toEqual(before);
  });
  it('dispatches only the next state with tracking, without an extra GP charge', async () => {
    const u = await actor(),
      r = await parcel(),
      id = r.fulfillmentId,
      before = (
        await query('SELECT "coinBalance" FROM users WHERE id=$1', [r.userId])
      )[0].coinBalance;
    await expect(
      s.dispatch(u, id, randomUUID(), {
        expectedVersion: 1,
        status: 'DELIVERED',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await s.dispatch(u, id, randomUUID(), {
      expectedVersion: 1,
      status: 'PREPARING',
    });
    await expect(
      s.dispatch(u, id, randomUUID(), {
        expectedVersion: 2,
        status: 'COLLECTED',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const key = randomUUID(),
      dto = {
        expectedVersion: 2,
        status: 'COLLECTED',
        carrier: 'CJ',
        trackingNumber: 'TEST12345',
      };
    const collected = await s.dispatch(u, id, key, dto);
    expect(await s.dispatch(u, id, key, dto)).toEqual(collected);
    await expect(shipping.cancel(r.userId, id)).rejects.toMatchObject({
      status: 409,
    });
    await s.dispatch(u, id, randomUUID(), {
      expectedVersion: 3,
      status: 'SHIPPING',
    });
    await s.dispatch(u, id, randomUUID(), {
      expectedVersion: 4,
      status: 'DELIVERED',
    });
    const receipt = await shipping.findOne(r.userId, id);
    expect(receipt).toMatchObject({
      status: 'DELIVERED',
      trackingNumber: 'TEST12345',
      trackingSource: 'OPERATOR',
      canCancel: false,
    });
    expect(
      (
        await query('SELECT status FROM inventory_items WHERE user_id=$1', [
          r.userId,
        ])
      ).every((i) => i.status === 'DELIVERED'),
    ).toBe(true);
    expect(
      (
        await query('SELECT "coinBalance" FROM users WHERE id=$1', [r.userId])
      )[0].coinBalance,
    ).toBe(before);
  });
  it('customer cancellation invalidates a stale dispatch and refunds exactly once', async () => {
    const u = await actor(),
      r = await parcel();
    await s.dispatch(u, r.fulfillmentId, randomUUID(), {
      expectedVersion: 1,
      status: 'PREPARING',
    });
    await shipping.cancel(r.userId, r.fulfillmentId);
    await shipping.cancel(r.userId, r.fulfillmentId);
    await expect(
      s.dispatch(u, r.fulfillmentId, randomUUID(), {
        expectedVersion: 2,
        status: 'COLLECTED',
        carrier: 'CJ',
        trackingNumber: 'TEST12345',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await query('SELECT "coinBalance" FROM users WHERE id=$1', [r.userId])
      )[0].coinBalance,
    ).toBe(900);
    expect((await s.shipment(u, r.fulfillmentId)).version).toBe(3);
  });
  it('rejects unsafe images and digital shipping, and stays disabled in production', async () => {
    expect(() =>
      catalogConfig({ ...config(), imageUrl: 'javascript:alert(1)' }),
    ).toThrow();
    const c = config();
    c.entries[0].fulfillmentType = 'DIGITAL';
    expect(() => catalogConfig(c)).toThrow();
    const u = await actor();
    process.env.NODE_ENV = 'production';
    try {
      await expect(s.create(u, randomUUID(), config())).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
