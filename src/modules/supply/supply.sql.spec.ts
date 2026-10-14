import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SupplyService } from './supply.service';
import { OperationsService } from '../operations/operations.service';
import { FulfillmentsService } from '../fulfillments/fulfillments.service';
import { SupportService } from '../account-support/support.service';
import { notify } from './supply.db';
import { conversionFixture } from '../../../test/helpers/conversion-fixture';
describe('warehouse and inbox SQL lifecycle', () => {
  let db: PGlite,
    s: SupplyService,
    ops: OperationsService,
    shipping: FulfillmentsService,
    support: SupportService;
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
    ops = new OperationsService(adapter);
    s = new SupplyService(adapter, ops);
    shipping = new FulfillmentsService(adapter);
    support = new SupportService(adapter);
  }, 30000);
  afterAll(async () => {
    await db?.close();
    process.env = env;
  });
  async function actor(
    permissions = ['WAREHOUSE', 'ANNOUNCEMENTS', 'FULFILLMENT'],
  ) {
    const [u] = await query(
      `INSERT INTO users(email,nickname) VALUES($1,'test') RETURNING id,email`,
      [randomUUID() + '@example.invalid'],
    );
    for (const p of permissions)
      await query(
        'INSERT INTO operations_permissions(user_id,permission) VALUES($1,$2)',
        [u.id, p],
      );
    return { userId: u.id, email: u.email, authVersion: 0 };
  }
  async function parcel() {
    const f = await conversionFixture(query, 2);
    await query(
      `UPDATE items SET fulfillment_type='PHYSICAL',shipping_enabled=true WHERE id IN(SELECT item_id FROM inventory_items WHERE user_id=$1)`,
      [f.userId],
    );
    const [p] = await query(
      'SELECT warehouse_sku_id FROM items WHERE id=(SELECT item_id FROM inventory_items WHERE id=$1)',
      [f.ids[0]],
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
    return {
      ...f,
      ...(await shipping.create(f.userId, randomUUID(), q.quoteId)),
      skuId: p.warehouse_sku_id,
    };
  }
  it('isolates roles and revokes old sessions', async () => {
    const a = await actor(['CATALOG']);
    await expect(s.skus(a, { page: 1, limit: 20 })).rejects.toMatchObject({
      status: 403,
    });
    expect((await s.skus(a, { page: 1, limit: 20 }, true)).items).toEqual([]);
    await query('UPDATE users SET auth_version=1 WHERE id=$1', [a.userId]);
    await expect(s.capabilities(a)).rejects.toMatchObject({ status: 401 });
  });
  it('creates empty stock, records receipt once and rejects changed payload or stale version', async () => {
    const a = await actor(),
      key = randomUUID(),
      c = { code: 'STOCK_' + a.userId, name: '창고 상품', reorderPoint: 2 },
      r = await s.createSku(a, key, c);
    expect(await s.createSku(a, key, c)).toEqual(r);
    expect((await s.sku(a, r.skuId)).onHand).toBe(0);
    const k = randomUUID(),
      d = {
        expectedVersion: 1,
        kind: 'RECEIVE',
        quantity: 10,
        reason: '실사 입고',
      };
    await s.movement(a, r.skuId, k, d);
    await s.movement(a, r.skuId, k, d);
    expect((await s.sku(a, r.skuId)).movements).toHaveLength(1);
    await expect(
      s.movement(a, r.skuId, k, { ...d, quantity: 11 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(s.movement(a, r.skuId, randomUUID(), d)).rejects.toMatchObject(
      { status: 409 },
    );
    await expect(
      s.movement(a, r.skuId, randomUUID(), {
        ...d,
        expectedVersion: 2,
        quantity: -1,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('groups a shared SKU, holds stock during preparation, and releases on cancellation once', async () => {
    const a = await actor(),
      r = await parcel();
    await ops.dispatch(a, r.fulfillmentId, randomUUID(), {
      expectedVersion: 1,
      status: 'PREPARING',
    });
    expect(await s.sku(a, r.skuId)).toMatchObject({
      onHand: 2,
      reserved: 2,
      available: 0,
    });
    await expect(
      s.movement(a, r.skuId, randomUUID(), {
        expectedVersion: 2,
        kind: 'ADJUST',
        quantity: -1,
        reason: 'damaged',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await shipping.cancel(r.userId, r.fulfillmentId);
    await shipping.cancel(r.userId, r.fulfillmentId);
    const stock = await s.sku(a, r.skuId);
    expect(stock).toMatchObject({ onHand: 2, reserved: 0, available: 2 });
    expect(stock.movements.map((x) => x.kind)).toEqual(['RELEASE', 'RESERVE']);
  });
  it('rolls back fulfillment state and notifications when stock is missing', async () => {
    const a = await actor(),
      r = await parcel();
    await s.movement(a, r.skuId, randomUUID(), {
      expectedVersion: 1,
      kind: 'ADJUST',
      quantity: -1,
      reason: 'damaged',
    });
    await expect(
      ops.dispatch(a, r.fulfillmentId, randomUUID(), {
        expectedVersion: 1,
        status: 'PREPARING',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await ops.shipment(a, r.fulfillmentId)).status).toBe('REQUESTED');
    expect((await s.sku(a, r.skuId)).reserved).toBe(0);
    expect(
      await query('SELECT * FROM app_notifications WHERE user_id=$1', [
        r.userId,
      ]),
    ).toHaveLength(1);
  });
  it('requires SKU links, reserves legacy preparation, and consumes the original SKU after relinking', async () => {
    const a = await actor(),
      r = await parcel();
    const [item] = await query(
      'SELECT item_id AS id FROM inventory_items WHERE id=$1',
      [r.ids[0]],
    );
    await query('UPDATE items SET warehouse_sku_id=NULL WHERE id=$1', [
      item.id,
    ]);
    await expect(
      ops.dispatch(a, r.fulfillmentId, randomUUID(), {
        expectedVersion: 1,
        status: 'PREPARING',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await s.link(a, item.id, randomUUID(), {
      expectedVersion: 0,
      skuId: r.skuId,
    });
    await query(
      "UPDATE fulfillment_orders SET status='PREPARING' WHERE id=$1",
      [r.fulfillmentId],
    );
    await expect(
      ops.dispatch(a, r.fulfillmentId, randomUUID(), {
        expectedVersion: 1,
        status: 'COLLECTED',
        carrier: 'CJ',
        trackingNumber: 'TEST12345',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await s.reserve(a, r.fulfillmentId, randomUUID(), 1);
    const other = await s.createSku(a, randomUUID(), {
      code: 'OTHER_' + a.userId,
      name: 'other',
      reorderPoint: 0,
    });
    await s.link(a, item.id, randomUUID(), {
      expectedVersion: 1,
      skuId: other.skuId,
    });
    const k = randomUUID(),
      d = {
        expectedVersion: 2,
        status: 'COLLECTED',
        carrier: 'CJ',
        trackingNumber: 'TEST12345',
      };
    await ops.dispatch(a, r.fulfillmentId, k, d);
    await ops.dispatch(a, r.fulfillmentId, k, d);
    expect(await s.sku(a, r.skuId)).toMatchObject({ onHand: 0, reserved: 0 });
    expect((await s.sku(a, r.skuId)).movements.map((x) => x.kind)).toEqual([
      'DISPATCH',
      'RESERVE',
    ]);
    expect((await s.sku(a, other.skuId)).onHand).toBe(0);
  });
  it('deduplicates notifications and scopes reads to the signed-in user and observed watermark', async () => {
    const a = await actor([]),
      b = await actor([]),
      id = randomUUID();
    await notify(
      { query } as any,
      a.userId,
      'event',
      'SUPPORT_REPLY',
      id,
      '답변',
      '확인',
    );
    await notify(
      { query } as any,
      a.userId,
      'event',
      'SUPPORT_REPLY',
      id,
      '답변',
      '확인',
    );
    const list = await s.notifications(a, { page: 1, limit: 20 });
    expect(list.totalCount).toBe(1);
    expect((await s.notifications(b, { page: 1, limit: 20 })).totalCount).toBe(
      0,
    );
    await expect(s.read(a, list.items[0].id + 1)).rejects.toMatchObject({
      status: 400,
    });
    await s.read(a, list.items[0].id);
    await notify(
      { query } as any,
      a.userId,
      'event2',
      'SUPPORT_REPLY',
      id,
      '답변',
      '확인',
    );
    await s.read(a, list.items[0].id);
    expect((await s.summary(a)).notifications).toBe(1);
  });
  it('creates an in-app notice only for a newly committed staff reply', async () => {
    const a = await actor([]),
      b = await actor([]);
    await query('INSERT INTO support_staff(user_id) VALUES($1)', [b.userId]);
    const ticket = await support.create(a, randomUUID(), {
        category: 'OTHER',
        subject: '도움 요청',
        body: '확인해주세요',
      }),
      key = randomUUID();
    await support.reply(b, ticket.ticketId, key, '답변 본문', true);
    await support.reply(b, ticket.ticketId, key, '답변 본문', true);
    const r = await s.notifications(a, { page: 1, limit: 20 });
    expect(r.totalCount).toBe(1);
    expect(r.items[0]).toMatchObject({
      kind: 'SUPPORT_REPLY',
      targetId: ticket.ticketId,
    });
    expect(r.items[0].body).not.toContain('답변 본문');
  });
  it('publishes reviewed notices, hides drafts and archives, and tracks per-user reading', async () => {
    const a = await actor(),
      b = await actor([]),
      d = {
        title: '서비스 안내',
        body: '새로운 운영 안내',
        category: 'NOTICE',
      },
      r = await s.saveAnnouncement(a, null, randomUUID(), d);
    await expect(s.announcement(b, r.announcementId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      s.announcementStatus(a, r.announcementId, randomUUID(), {
        expectedVersion: 1,
        status: 'PUBLISHED',
        confirmed: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await s.announcementStatus(a, r.announcementId, randomUUID(), {
      expectedVersion: 1,
      status: 'PUBLISHED',
      confirmed: true,
    });
    expect((await s.summary(b)).announcements).toBe(1);
    await s.readAnnouncement(b, r.announcementId);
    expect((await s.summary(b)).announcements).toBe(0);
    expect((await s.summary(a)).announcements).toBe(1);
    await expect(
      s.saveAnnouncement(a, r.announcementId, randomUUID(), {
        ...d,
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await s.announcementStatus(a, r.announcementId, randomUUID(), {
      expectedVersion: 2,
      status: 'ARCHIVED',
      confirmed: true,
    });
    await expect(s.announcement(b, r.announcementId)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await s.announcements(a, { page: 1, limit: 20 }, true)).items,
    ).toHaveLength(1);
  });
});
