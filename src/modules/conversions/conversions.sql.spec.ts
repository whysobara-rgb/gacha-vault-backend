import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ConversionsService } from './conversions.service';
import { conversionFixture } from '../../../test/helpers/conversion-fixture';
import {
  amountFrom,
  normalizeIds,
  policyFrom,
  previewEnabled,
} from './conversion.policy';
// Real PostgreSQL WASM execution of migrations, SQL and rollback. This does not
// replace the separate multi-connection PostgreSQL concurrency suite.
describe('GP conversion SQL lifecycle', () => {
  let db: PGlite, service: ConversionsService;
  const env = { ...process.env };
  const query = async (s: string, p: any[] = []) =>
    (await db.query(s, p)).rows as any[];
  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ENABLE_GP_CONVERSION_PREVIEW: 'true',
      ENABLE_LEGACY_TRANSACTIONS: 'false',
      GP_RESTORE_WINDOW_HOURS: '24',
      GP_RESTORE_MAX_PER_ITEM: '1',
    });
    db = new PGlite();
    await db.waitReady;
    for (const file of readdirSync(join(__dirname, '../../database/migrations'))
      .filter((f) => f.endsWith('.ts'))
      .sort()) {
      const mod = require('../../database/migrations/' + file),
        Cls: any = Object.values(mod)[0];
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
    service = new ConversionsService(adapter as unknown as DataSource);
  }, 30000);
  afterAll(async () => {
    await db?.close();
    process.env = env;
  });
  const execute = async (u: number, ids: number[], key = randomUUID()) => {
    const q = await service.quote(u, ids);
    return service.convert(u, key, {
      inventoryItemIds: ids,
      expectedTotalGP: q.totalGP,
      expectedQuoteVersion: q.quoteVersion,
    });
  };
  it('uses 10%/100% snapshot policy, credits once, restores once, and preserves ledger', async () => {
    const f = await conversionFixture(query),
      q = await service.quote(f.userId, f.ids),
      key = randomUUID(),
      dto = {
        inventoryItemIds: f.ids,
        expectedTotalGP: q.totalGP,
        expectedQuoteVersion: q.quoteVersion,
      };
    expect(q.totalGP).toBe(1010);
    const r = await service.convert(f.userId, key, dto);
    expect(r.balanceAfter).toBe(1910);
    expect((await service.convert(f.userId, key, dto)).conversionId).toBe(
      r.conversionId,
    );
    expect(
      (await service.restore(f.userId, r.conversionId)).restoredBalanceAfter,
    ).toBe(900);
    await service.restore(f.userId, r.conversionId);
    const [x] = await query(
      `SELECT count(*) AS n,sum(amount) AS total FROM wallet_transactions WHERE user_id=$1 AND origin<>'LEGACY'`,
      [f.userId],
    );
    expect(Number(x.n)).toBe(2);
    expect(Number(x.total)).toBe(0);
    expect(
      (
        await query('SELECT status FROM inventory_items WHERE user_id=$1', [
          f.userId,
        ])
      ).every((x) => x.status === 'STORED'),
    ).toBe(true);
  });
  it('recovers the original request without crediting again or exposing another account', async () => {
    const f = await conversionFixture(query),
      other = await conversionFixture(query, 1);
    const key = randomUUID(),
      r = await execute(f.userId, f.ids, key);
    expect((await service.byRequest(f.userId, key)).conversionId).toBe(
      r.conversionId,
    );
    await expect(service.byRequest(other.userId, key)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.byRequest(f.userId, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    await service.restore(f.userId, r.conversionId);
    expect((await service.byRequest(f.userId, key)).status).toBe('RESTORED');
    const [row] = await query(
      "SELECT count(*) AS n FROM wallet_transactions WHERE user_id=$1 AND origin='INVENTORY_CONVERSION'",
      [f.userId],
    );
    expect(Number(row.n)).toBe(1);
  });
  it('rejects locked, shipped and foreign selections without partial credits', async () => {
    const f = await conversionFixture(query),
      other = await conversionFixture(query, 1);
    await query('UPDATE inventory_items SET "isLocked"=true WHERE id=$1', [
      f.ids[1],
    ]);
    await expect(execute(f.userId, f.ids)).rejects.toMatchObject({
      status: 409,
    });
    await expect(execute(other.userId, [f.ids[0]])).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (
        await query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
          f.userId,
        ])
      )[0].n,
    ).toBe(900);
    await query("UPDATE inventory_items SET status='SHIPPING' WHERE id=$1", [
      f.ids[0],
    ]);
    await expect(execute(f.userId, [f.ids[0]])).rejects.toMatchObject({
      status: 409,
    });
  });
  it('uses immutable opening value even when the live product price changes', async () => {
    const f = await conversionFixture(query, 1);
    await query(
      'UPDATE items SET "estimatedValue"=500000,"conversionGP"=50000 WHERE id=(SELECT item_id FROM inventory_items WHERE id=$1)',
      [f.ids[0]],
    );
    expect((await execute(f.userId, f.ids)).totalGP).toBe(10);
  });
  it('rejects stale quote and changed idempotency payload', async () => {
    const f = await conversionFixture(query),
      q = await service.quote(f.userId, f.ids);
    await expect(
      service.convert(f.userId, randomUUID(), {
        inventoryItemIds: f.ids,
        expectedTotalGP: q.totalGP + 1,
        expectedQuoteVersion: q.quoteVersion,
      }),
    ).rejects.toMatchObject({ status: 409 });
    const key = randomUUID();
    await service.convert(f.userId, key, {
      inventoryItemIds: f.ids,
      expectedTotalGP: q.totalGP,
      expectedQuoteVersion: q.quoteVersion,
    });
    await expect(
      service.convert(f.userId, key, {
        inventoryItemIds: f.ids.slice(0, 1),
        expectedTotalGP: q.totalGP,
        expectedQuoteVersion: q.quoteVersion,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('blocks restoration after GP spend even if balance later increases', async () => {
    const f = await conversionFixture(query, 1),
      r = await execute(f.userId, f.ids);
    await query(
      `INSERT INTO wallet_transactions(user_id,type,amount,description,"balanceAfter") VALUES($1,'USE',-1,'purchase',909)`,
      [f.userId],
    );
    await query('UPDATE users SET "coinBalance"=10000 WHERE id=$1', [f.userId]);
    expect(
      (await service.findOne(f.userId, r.conversionId)).restoreReason,
    ).toContain('GP 사용');
    await expect(
      service.restore(f.userId, r.conversionId),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('enforces expiry and per-item restore count', async () => {
    const f = await conversionFixture(query, 1),
      r = await execute(f.userId, f.ids);
    await service.restore(f.userId, r.conversionId);
    expect((await service.quote(f.userId, f.ids)).restoreEligible).toBe(false);
    const second = await execute(f.userId, f.ids);
    expect(second.canRestore).toBe(false);
    expect(second.restoreReason).toContain('횟수');
    const g = await conversionFixture(query, 1),
      expired = await execute(g.userId, g.ids);
    await query(
      "UPDATE inventory_conversions SET restore_until=now()-interval '1 second' WHERE id=$1",
      [expired.conversionId],
    );
    await expect(
      service.restore(g.userId, expired.conversionId),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rolls back wallet and inventory when ledger insert fails', async () => {
    const f = await conversionFixture(query, 1);
    await query(
      `CREATE FUNCTION fail_test_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.origin='INVENTORY_CONVERSION' THEN RAISE EXCEPTION 'simulated'; END IF; RETURN NEW; END $$`,
    );
    await query(
      'CREATE TRIGGER fail_test_ledger BEFORE INSERT ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION fail_test_ledger()',
    );
    try {
      await expect(execute(f.userId, f.ids)).rejects.toThrow('simulated');
      expect(
        Number(
          (
            await query('SELECT "coinBalance" AS n FROM users WHERE id=$1', [
              f.userId,
            ])
          )[0].n,
        ),
      ).toBe(900);
      expect(
        (
          await query('SELECT status FROM inventory_items WHERE id=$1', [
            f.ids[0],
          ])
        )[0].status,
      ).toBe('STORED');
    } finally {
      await query('DROP TRIGGER fail_test_ledger ON wallet_transactions');
      await query('DROP FUNCTION fail_test_ledger()');
    }
  });
  it('handles 100 items as one conversion and refuses 101 or duplicate IDs', async () => {
    const f = await conversionFixture(query, 100);
    const r = await execute(f.userId, f.ids);
    expect(r.items).toHaveLength(100);
    expect(r.totalGP).toBe(50500);
    expect(() => normalizeIds([...f.ids, 99999])).toThrow();
    expect(() => normalizeIds([f.ids[0], f.ids[0]])).toThrow();
  });
  it('keeps server preview disabled in production and requires explicit restore policy', () => {
    expect(previewEnabled({ ...process.env, NODE_ENV: 'production' })).toBe(
      false,
    );
    expect(() => policyFrom({})).toThrow();
    expect(() =>
      amountFrom({
        estimatedValue: 100,
        isPremium: false,
        conversionGP: 100,
      } as any),
    ).toThrow();
  });
  it('keeps history scoped to the owner with paginated receipts', async () => {
    const f = await conversionFixture(query, 1),
      r = await execute(f.userId, f.ids),
      other = await conversionFixture(query, 1);
    await expect(
      service.findOne(other.userId, r.conversionId),
    ).rejects.toMatchObject({ status: 404 });
    const rows = await service.list(f.userId, 1, 1);
    expect(rows.totalCount).toBe(1);
    expect(rows.items[0].conversionId).toBe(r.conversionId);
  });
});
