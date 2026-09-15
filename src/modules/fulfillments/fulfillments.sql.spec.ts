import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { FulfillmentsService } from './fulfillments.service';
import { ConversionsService } from '../conversions/conversions.service';
import { conversionFixture } from '../../../test/helpers/conversion-fixture';
import {
  rateTable,
  recipientFrom,
  shippingEnabled,
  zoneFor,
} from './fulfillment.policy';
const recipient = {
  name: 'Test recipient',
  phone: '01000000000',
  postalCode: '00000',
  address1: 'Test address 1',
  address2: '101',
  notes: '',
  country: 'KR' as const,
};
const rates = JSON.stringify([
  { id: 'test', label: 'Test only', prefixes: ['*'], feeGP: 3000 },
]);
describe('fulfillment SQL lifecycle (PGlite, not multi-connection concurrency)', () => {
  let db: PGlite, service: FulfillmentsService, conversions: ConversionsService;
  const env = { ...process.env };
  const query = async (s: string, p: any[] = []) =>
    (await db.query(s, p)).rows as any[];
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_SHIPPING_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      SHIPPING_RATE_TABLE_JSON: rates,
      ENABLE_GP_CONVERSION_PREVIEW: 'true',
      GP_RESTORE_WINDOW_HOURS: '24',
      GP_RESTORE_MAX_PER_ITEM: '1',
    });
    db = new PGlite();
    await db.waitReady;
    for (const f of readdirSync(join(__dirname, '../../database/migrations'))
      .filter((f) => f.endsWith('.ts'))
      .sort()) {
      const Cls: any = Object.values(
        require('../../database/migrations/' + f),
      )[0];
      await db.transaction(async (tx) =>
        new Cls().up({ query: async (s, p) => (await tx.query(s, p)).rows }),
      );
    }
    const adapter = {
      transaction: async (...args: any[]) =>
        db.transaction(async (tx) =>
          args[args.length - 1]({
            query: async (s, p) => (await tx.query(s, p)).rows,
          }),
        ),
    };
    service = new FulfillmentsService(adapter as unknown as DataSource);
    conversions = new ConversionsService(adapter as unknown as DataSource);
  }, 30000);
  afterAll(async () => {
    await db?.close();
    process.env = env;
  });
  beforeEach(() => {
    process.env.SHIPPING_RATE_TABLE_JSON = rates;
    process.env.ENABLE_SHIPPING_PREVIEW = 'true';
  });
  const fixture = async (n = 2) => {
    const f = await conversionFixture(query, n);
    await query(
      `UPDATE items SET shipping_enabled=true,fulfillment_type='PHYSICAL' WHERE id IN(SELECT item_id FROM inventory_items WHERE user_id=$1)`,
      [f.userId],
    );
    await query(`UPDATE users SET "coinBalance"=5000 WHERE id=$1`, [f.userId]);
    await query(
      `INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",description) VALUES($1,'EARN',4100,5000,'test funds')`,
      [f.userId],
    );
    return f;
  };
  const quote = (f: any, ids = f.ids) =>
    service.quote(f.userId, { inventoryItemIds: ids, recipient });
  const balance = async (u: number) =>
    Number(
      (await query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [u]))[0]
        .n,
    );
  it('charges once, accepts conversion-locked items, cancels once and restores lock/state', async () => {
    const f = await fixture();
    await query('UPDATE inventory_items SET "isLocked"=true WHERE id=$1', [
      f.ids[0],
    ]);
    const q = await quote(f),
      key = randomUUID(),
      r = await service.create(f.userId, key, q.quoteId);
    expect(r.feeGP).toBe(3000);
    expect(await balance(f.userId)).toBe(2000);
    expect((await service.create(f.userId, key, q.quoteId)).fulfillmentId).toBe(
      r.fulfillmentId,
    );
    expect((await service.byRequest(f.userId, key)).fulfillmentId).toBe(
      r.fulfillmentId,
    );
    await service.cancel(f.userId, r.fulfillmentId);
    await service.cancel(f.userId, r.fulfillmentId);
    expect(await balance(f.userId)).toBe(5000);
    const rows = await query(
      'SELECT status,"isLocked" FROM inventory_items WHERE user_id=$1 ORDER BY id',
      [f.userId],
    );
    expect(rows.map((i) => i.status)).toEqual(['STORED', 'STORED']);
    expect(rows[0].isLocked).toBe(true);
    expect(
      Number(
        (
          await query(
            "SELECT count(*) AS n FROM wallet_transactions WHERE user_id=$1 AND origin LIKE 'SHIPPING_%'",
            [f.userId],
          )
        )[0].n,
      ),
    ).toBe(2);
    const q2 = await quote(f);
    await service.create(f.userId, randomUUID(), q2.quoteId);
    expect(await balance(f.userId)).toBe(2000);
  });
  it('rejects insufficient funds without reserving inventory or writing a fee', async () => {
    const f = await fixture(),
      q = await quote(f);
    await query('UPDATE users SET "coinBalance"=1 WHERE id=$1', [f.userId]);
    await expect(
      service.create(f.userId, randomUUID(), q.quoteId),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.list(f.userId)).totalCount).toBe(0);
    expect(
      (
        await query('SELECT status FROM inventory_items WHERE id=$1', [
          f.ids[0],
        ])
      )[0].status,
    ).toBe('STORED');
    expect(await balance(f.userId)).toBe(1);
  });
  it('rejects foreign, unclassified, disabled and digital products and invalid recipients', async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(quote(other, f.ids)).rejects.toMatchObject({ status: 404 });
    for (const type of ['DIGITAL', 'MANUAL', 'UNSPECIFIED']) {
      await query(
        'UPDATE items SET fulfillment_type=$1 WHERE id=(SELECT item_id FROM inventory_items WHERE id=$2)',
        [type, f.ids[0]],
      );
      await expect(quote(f)).rejects.toMatchObject({ status: 409 });
    }
    await query(
      "UPDATE items SET fulfillment_type='PHYSICAL',shipping_enabled=false WHERE id=(SELECT item_id FROM inventory_items WHERE id=$1)",
      [f.ids[0]],
    );
    await expect(quote(f)).rejects.toMatchObject({ status: 409 });
    expect(() => recipientFrom({ ...recipient, postalCode: '123' })).toThrow();
    expect(() => recipientFrom({ ...recipient, notes: 'a\nb' })).toThrow();
  });
  it('revalidates catalog eligibility, item state, fee table and expiry at commit', async () => {
    const f = await fixture(),
      q = await quote(f);
    await query("UPDATE inventory_items SET status='CONVERTED' WHERE id=$1", [
      f.ids[0],
    ]);
    await expect(
      service.create(f.userId, randomUUID(), q.quoteId),
    ).rejects.toMatchObject({ status: 409 });
    await query("UPDATE inventory_items SET status='STORED' WHERE id=$1", [
      f.ids[0],
    ]);
    process.env.SHIPPING_RATE_TABLE_JSON = rates.replace('3000', '3500');
    await expect(
      service.create(f.userId, randomUUID(), q.quoteId),
    ).rejects.toMatchObject({ status: 409 });
    process.env.SHIPPING_RATE_TABLE_JSON = rates;
    await query(
      "UPDATE fulfillment_quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
      [q.quoteId],
    );
    await expect(
      service.create(f.userId, randomUUID(), q.quoteId),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance(f.userId)).toBe(5000);
  });
  it('binds idempotency to the original quote and reserves each item once', async () => {
    const f = await fixture(),
      q = await quote(f),
      q2 = await quote(f),
      key = randomUUID();
    const r = await service.create(f.userId, key, q.quoteId);
    await expect(
      service.create(f.userId, key, q2.quoteId),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.create(f.userId, randomUUID(), q2.quoteId),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.create(f.userId, randomUUID(), q.quoteId),
    ).rejects.toMatchObject({ status: 409 });
    await service.cancel(f.userId, r.fulfillmentId);
    expect((await service.create(f.userId, key, q.quoteId)).status).toBe(
      'CANCELLED',
    );
    expect(await balance(f.userId)).toBe(5000);
  });
  it('cancels during preparation only and rejects collected/shipping/delivered statuses', async () => {
    const f = await fixture(),
      q = await quote(f),
      r = await service.create(f.userId, randomUUID(), q.quoteId);
    for (const status of ['COLLECTED', 'SHIPPING', 'DELIVERED']) {
      await query('UPDATE fulfillment_orders SET status=$1 WHERE id=$2', [
        status,
        r.fulfillmentId,
      ]);
      await expect(
        service.cancel(f.userId, r.fulfillmentId),
      ).rejects.toMatchObject({ status: 409 });
    }
    await query(
      "UPDATE fulfillment_orders SET status='PREPARING' WHERE id=$1",
      [r.fulfillmentId],
    );
    expect((await service.cancel(f.userId, r.fulfillmentId)).status).toBe(
      'CANCELLED',
    );
  });
  it('does not undo conversion restoration restrictions when a shipping fee is refunded', async () => {
    const f = await fixture(),
      cq = await conversions.quote(f.userId, [f.ids[0]]),
      c = await conversions.convert(f.userId, randomUUID(), {
        inventoryItemIds: [f.ids[0]],
        expectedTotalGP: cq.totalGP,
        expectedQuoteVersion: cq.quoteVersion,
      }),
      q = await quote(f, [f.ids[1]]),
      r = await service.create(f.userId, randomUUID(), q.quoteId);
    await service.cancel(f.userId, r.fulfillmentId);
    expect(
      (await conversions.findOne(f.userId, c.conversionId)).canRestore,
    ).toBe(false);
    expect(
      (await conversions.findOne(f.userId, c.conversionId)).restoreReason,
    ).toContain('GP 사용');
  });
  it('rolls back both create and cancellation when their ledger writes fail', async () => {
    const f = await fixture(),
      q = await quote(f);
    await query(
      `CREATE FUNCTION fail_shipping_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin LIKE 'SHIPPING_%' THEN RAISE EXCEPTION 'simulated shipping'; END IF; RETURN NEW; END $$`,
    );
    const trigger = () =>
      query(
        'CREATE TRIGGER fail_shipping_ledger BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION fail_shipping_ledger()',
      );
    await trigger();
    try {
      await expect(
        service.create(f.userId, randomUUID(), q.quoteId),
      ).rejects.toThrow('simulated shipping');
      expect(await balance(f.userId)).toBe(5000);
      expect((await service.list(f.userId)).totalCount).toBe(0);
      await query('DROP TRIGGER fail_shipping_ledger ON wallet_transactions');
      const r = await service.create(f.userId, randomUUID(), q.quoteId);
      await trigger();
      await expect(service.cancel(f.userId, r.fulfillmentId)).rejects.toThrow(
        'simulated shipping',
      );
      expect(await balance(f.userId)).toBe(2000);
      expect((await service.findOne(f.userId, r.fulfillmentId)).status).toBe(
        'REQUESTED',
      );
    } finally {
      await query(
        'DROP TRIGGER IF EXISTS fail_shipping_ledger ON wallet_transactions',
      );
      await query('DROP FUNCTION fail_shipping_ledger()');
    }
  });
  it('supports 100-item, zero-fee requests, owner-only history and bounded quote storage', async () => {
    process.env.SHIPPING_RATE_TABLE_JSON = rates.replace('3000', '0');
    const f = await fixture(100),
      other = await fixture(1),
      q = await quote(f),
      r = await service.create(f.userId, randomUUID(), q.quoteId);
    expect(r.items).toHaveLength(100);
    expect(await balance(f.userId)).toBe(5000);
    await expect(
      service.findOne(other.userId, r.fulfillmentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.getQuote(other.userId, q.quoteId),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.list(f.userId, 1, 1)).items).toHaveLength(1);
    await service.cancel(f.userId, r.fulfillmentId);
    for (let i = 0; i < 20; i++) await quote(other);
    await expect(quote(other)).rejects.toMatchObject({ status: 429 });
  });
  it('requires explicit rate configuration and keeps production mutations disabled', () => {
    expect(shippingEnabled({ ...process.env, NODE_ENV: 'production' })).toBe(
      false,
    );
    expect(() => rateTable({})).toThrow();
    expect(() =>
      rateTable({
        SHIPPING_RATE_TABLE_JSON:
          '[{"id":"x","label":"x","prefixes":["*","*"],"feeGP":1}]',
      }),
    ).toThrow();
    const t = rateTable({
      SHIPPING_RATE_TABLE_JSON: JSON.stringify([
        { id: 'base', label: 'Base', prefixes: ['*'], feeGP: 1000 },
        { id: 'area', label: 'Area', prefixes: ['12'], feeGP: 2000 },
        { id: 'exact', label: 'Exact', prefixes: ['12345'], feeGP: 3000 },
      ]),
    });
    expect(zoneFor('12345', t).feeGP).toBe(3000);
    expect(zoneFor('12999', t).feeGP).toBe(2000);
    expect(() =>
      zoneFor(
        '99999',
        t.filter((r) => r.id !== 'base'),
      ),
    ).toThrow();
  });
});
