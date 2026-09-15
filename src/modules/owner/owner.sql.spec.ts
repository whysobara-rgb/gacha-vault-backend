import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ownerAccess } from '../../database/commands/owner-access';
import { OwnerService } from './owner.service';
import { OperationsService } from '../operations/operations.service';
import { conversionFixture } from '../../../test/helpers/conversion-fixture';
describe('owner console SQL lifecycle', () => {
  let db: PGlite, s: OwnerService, ops: OperationsService, adapter: DataSource;
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
    adapter = {
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
    s = new OwnerService(adapter, ops);
  }, 30000);
  afterAll(async () => {
    await db?.close();
    process.env = env;
  });
  async function actor(permissions = ['OWNER']) {
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

  async function sku() {
    const [r] = await query(
      'INSERT INTO warehouse_skus(code,name) VALUES($1,$2) RETURNING id',
      [randomUUID(), '검수 상품'],
    );
    return r.id;
  }
  const campaign = () => ({
    title: '새로운 기획전',
    body: '공개 안내 내용',
    kind: 'NOTICE',
    gachaId: null,
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 86400000).toISOString(),
    budgetKRW: 30000,
  });
  it('bootstraps only the exact existing account, defaults to dry run and revokes sessions on access changes', async () => {
    const a = await actor([]);
    await expect(
      ownerAccess(adapter, a.userId, 'wrong@example.invalid', 'grant', true),
    ).rejects.toThrow('do not match');
    expect(
      (await ownerAccess(adapter, a.userId, a.email, 'grant')).applied,
    ).toBe(false);
    expect(
      await query('SELECT * FROM operations_permissions WHERE user_id=$1', [
        a.userId,
      ]),
    ).toHaveLength(0);
    await ownerAccess(adapter, a.userId, a.email, 'grant', true);
    await expect(s.capabilities(a)).rejects.toMatchObject({ status: 401 });
    expect((await s.capabilities({ ...a, authVersion: 1 })).contract).toBe(
      'OWNER_CONSOLE_V1',
    );
    expect(
      await query(
        'SELECT * FROM support_staff WHERE user_id=$1 AND active=true',
        [a.userId],
      ),
    ).toHaveLength(1);
    await ownerAccess(adapter, a.userId, a.email, 'revoke', true);
    await expect(
      s.capabilities({ ...a, authVersion: 2 }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await query(
        'SELECT * FROM support_staff WHERE user_id=$1 AND active=true',
        [a.userId],
      ),
    ).toHaveLength(0);
  });
  it('denies ordinary users and revoked sessions without exposing operational totals', async () => {
    const a = await actor([]);
    await expect(s.overview(a)).rejects.toMatchObject({ status: 403 });
    await expect(
      s.procurements(a, { page: 1, limit: 20 }),
    ).rejects.toMatchObject({ status: 403 });
    const owner = await actor();
    await query('UPDATE users SET auth_version=1 WHERE id=$1', [owner.userId]);
    await expect(s.capabilities(owner)).rejects.toMatchObject({ status: 401 });
  });
  it('partially receives and completes a procurement exactly once; rejects stale and excess receipts', async () => {
    const a = await actor(),
      idSku = await sku(),
      key = randomUUID();
    const d = {
      skuId: idSku,
      supplier: '공급사 A',
      reference: 'PO-001',
      quantity: 5,
      unitCostKRW: 2000,
      expectedAt: new Date().toISOString(),
    };
    const p = await s.createProcurement(a, key, d);
    expect(await s.createProcurement(a, key, d)).toEqual(p);
    await expect(
      s.createProcurement(a, key, { ...d, quantity: 9 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.changeProcurement(a, p.id, randomUUID(), {
        action: 'RECEIVE',
        quantity: 1,
        expectedVersion: 1,
        confirmed: true,
        reason: '검수',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await s.changeProcurement(a, p.id, randomUUID(), {
      action: 'ORDERED',
      expectedVersion: 1,
      confirmed: true,
      reason: '공급사 주문 완료',
    });
    const receiveKey = randomUUID(),
      r = {
        action: 'RECEIVE',
        quantity: 2,
        expectedVersion: 2,
        confirmed: true,
        reason: '부분 입고 검수',
      };
    const received = await s.changeProcurement(a, p.id, receiveKey, r);
    expect(received.status).toBe('PARTIAL');
    expect(await s.changeProcurement(a, p.id, receiveKey, r)).toEqual(received);
    await expect(
      s.changeProcurement(a, p.id, randomUUID(), r),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.changeProcurement(a, p.id, randomUUID(), {
        ...r,
        expectedVersion: 3,
        quantity: 4,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      s.changeProcurement(a, p.id, randomUUID(), {
        action: 'CANCELLED',
        expectedVersion: 3,
        confirmed: true,
        reason: '취소',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await s.changeProcurement(a, p.id, randomUUID(), {
      ...r,
      expectedVersion: 3,
      quantity: 3,
    });
    expect(
      (
        await query('SELECT on_hand FROM warehouse_skus WHERE id=$1', [idSku])
      )[0].on_hand,
    ).toBe(5);
    expect(
      (
        await query(
          'SELECT count(*)::int AS n FROM warehouse_movements WHERE sku_id=$1',
          [idSku],
        )
      )[0].n,
    ).toBe(2);
    const list = await s.procurements(a, { page: 1, limit: 20 });
    expect(list.items.find((x) => x.id === p.id)).toMatchObject({
      received: 5,
      status: 'RECEIVED',
      version: 4,
    });
  });
  it('validates dates, confirmation, empty supplier, negative cost and unexpected actions', async () => {
    const a = await actor();
    for (const d of [
      { supplier: '', unitCostKRW: 1, expectedAt: new Date().toISOString() },
      {
        supplier: '공급사',
        unitCostKRW: -1,
        expectedAt: new Date().toISOString(),
      },
      { supplier: '공급사', unitCostKRW: 1, expectedAt: '2026-09-15T12:00' },
    ])
      await expect(
        s.createProcurement(a, randomUUID(), {
          skuId: 1,
          reference: '',
          quantity: 1,
          ...d,
        }),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      s.changeProcurement(a, randomUUID(), randomUUID(), {
        action: 'RECEIVE',
        quantity: 1,
        expectedVersion: 1,
        reason: '검수',
        confirmed: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      s.saveCampaign(a, null, randomUUID(), {
        ...campaign(),
        endsAt: '2020-01-01T00:00:00Z',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('publishes only reviewed active-period campaigns and never exposes budgets to customers', async () => {
    const a = await actor(),
      c = await s.saveCampaign(a, null, randomUUID(), campaign());
    expect((await s.publicCampaigns()).items.some((x) => x.id === c.id)).toBe(
      false,
    );
    await s.campaignState(a, c.id, randomUUID(), {
      expectedVersion: 1,
      status: 'PUBLISHED',
      confirmed: true,
    });
    const publicRow = (await s.publicCampaigns()).items.find(
      (x) => x.id === c.id,
    );
    expect(publicRow.title).toBe('새로운 기획전');
    expect(publicRow).not.toHaveProperty('budgetKRW');
    expect(publicRow).not.toHaveProperty('version');
    await expect(
      s.saveCampaign(a, c.id, randomUUID(), {
        ...campaign(),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await s.campaignState(a, c.id, randomUUID(), {
      expectedVersion: 2,
      status: 'PAUSED',
      confirmed: true,
    });
    expect((await s.publicCampaigns()).items.some((x) => x.id === c.id)).toBe(
      false,
    );
    const saved = await s.saveCampaign(a, c.id, randomUUID(), {
      ...campaign(),
      expectedVersion: 3,
    });
    expect(saved.status).toBe('DRAFT');
    await s.campaignState(a, c.id, randomUUID(), {
      expectedVersion: 4,
      status: 'ARCHIVED',
      confirmed: true,
    });
    await expect(
      s.campaignState(a, c.id, randomUUID(), {
        expectedVersion: 5,
        status: 'PUBLISHED',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('filters future, expired and paused-box campaigns by server time', async () => {
    const a = await actor(),
      future = await s.saveCampaign(a, null, randomUUID(), {
        ...campaign(),
        startsAt: new Date(Date.now() + 3600000).toISOString(),
      });
    await s.campaignState(a, future.id, randomUUID(), {
      expectedVersion: 1,
      status: 'PUBLISHED',
      confirmed: true,
    });
    expect(
      (await s.publicCampaigns()).items.some((x) => x.id === future.id),
    ).toBe(false);
    const [g] = await query(
      'INSERT INTO gachas(title,price,currency,active) VALUES($1,100,$2,true) RETURNING id',
      ['기획전 박스', 'GP'],
    );
    const c = await s.saveCampaign(a, null, randomUUID(), {
      ...campaign(),
      kind: 'SHOWCASE',
      gachaId: g.id,
    });
    await s.campaignState(a, c.id, randomUUID(), {
      expectedVersion: 1,
      status: 'PUBLISHED',
      confirmed: true,
    });
    expect((await s.publicCampaigns()).items.some((x) => x.id === c.id)).toBe(
      true,
    );
    await query('UPDATE gachas SET active=false WHERE id=$1', [g.id]);
    expect((await s.publicCampaigns()).items.some((x) => x.id === c.id)).toBe(
      false,
    );
    await query(
      "UPDATE owner_campaigns SET starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' WHERE id=$1",
      [c.id],
    );
    expect((await s.publicCampaigns()).items.some((x) => x.id === c.id)).toBe(
      false,
    );
  });
  it('pauses new sales once with an audit record and preserves existing orders', async () => {
    const a = await actor(),
      f = await conversionFixture(query, 1),
      key = randomUUID();
    await query('UPDATE gachas SET active=true');
    const before = (
      await query('SELECT count(*)::int AS n FROM capsule_orders')
    )[0].n;
    await expect(
      s.pauseSales(a, randomUUID(), {
        confirmation: 'yes',
        reason: '중지 테스트',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const p = {
      confirmation: '전체 신규 판매 중지',
      reason: '배송 업무 정상화',
    };
    const r = await s.pauseSales(a, key, p);
    expect(r.pausedCount).toBeGreaterThan(0);
    expect(await s.pauseSales(a, key, p)).toEqual(r);
    expect(
      (
        await query('SELECT count(*)::int AS n FROM gachas WHERE active=true')
      )[0].n,
    ).toBe(0);
    expect(
      (await query('SELECT count(*)::int AS n FROM capsule_orders'))[0].n,
    ).toBe(before);
    const dashboard = await s.overview(a);
    expect(dashboard.work.activeBoxes).toBe(0);
    expect(dashboard.sales.orders7d).toBeGreaterThan(0);
    expect(dashboard.sales.grossKRW7d).toBe('0');
    expect(dashboard.sales.spentGP7d).not.toBe('0');
    expect(
      (await s.orders(a, { page: 1, limit: 20 })).items.length,
    ).toBeGreaterThan(0);
    expect((await s.finance(a, { page: 1, limit: 20 })).items).toEqual([]);
    expect(
      (await s.audit(a, { page: 1, limit: 100 })).items.some(
        (x) => x.event === 'SALES_PAUSED',
      ),
    ).toBe(true);
  });
});
