import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { DataSource, QueryRunner } from 'typeorm';
import { dataSourceOptions } from '../src/config/typeorm.config';
const { inspectMigrations, applyMigrations } = require('../tools/release/migrations.cjs');

const local = {
  type: 'postgres' as const, host: '127.0.0.1',
  port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
  username: 'gacha_ci', password: 'local-ci-only', ssl: false,
  synchronize: false, migrationsRun: false, dropSchema: false, logging: false as const,
  extra: { max: 4, connectionTimeoutMillis: 10000, statement_timeout: 15000 },
};
class First1700000000001 {
  async up(r: QueryRunner) { await r.query('CREATE TABLE guard_example(id integer PRIMARY KEY, value text)'); await r.query("INSERT INTO guard_example VALUES(1,'preserved')"); }
  async down(r: QueryRunner) { await r.query('DROP TABLE guard_example'); }
}
class Second1700000000002 {
  async up(r: QueryRunner) { await r.query('ALTER TABLE guard_example ADD note text'); }
  async down(r: QueryRunner) { await r.query('ALTER TABLE guard_example DROP COLUMN note'); }
}
class Failure1700000000002 {
  async up(r: QueryRunner) { await r.query("SELECT 'synthetic'::integer"); }
  async down() {}
}
const approval = (plan: any) => ({ expectedTarget: plan.targetFingerprint,
  expectedPlan: plan.planFingerprint, backupVerified: true, backupReference: 'SYNTHETIC_EMPTY_TEST_DB' });

describe('guarded deployment migrations on isolated local PostgreSQL', () => {
  const admin = new DataSource({ ...local, database: 'postgres' });
  let database: string;
  let sources: DataSource[];
  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test' || process.env.TEST_POSTGRES !== 'true')
      throw new Error('Dedicated local test DB opt-in required');
    await admin.initialize();
  });
  beforeEach(async () => {
    database = 'gacha_guard_' + randomUUID().replace(/-/g, '');
    sources = [];
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  });
  afterEach(async () => {
    for (const db of sources) if (db.isInitialized) await db.destroy();
    if (database) await admin.query(`DROP DATABASE "${database}"`);
  });
  afterAll(async () => { if (admin.isInitialized) await admin.destroy(); });
  async function connect(migrations: any[] = [First1700000000001, Second1700000000002]) {
    const db = new DataSource({ ...local, database, entities: dataSourceOptions.entities, migrations });
    sources.push(db);
    await db.initialize();
    return db;
  }
  const tables = (db: DataSource) => db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");

  it('plans in a read-only transaction without even creating a migration table', async () => {
    const db = await connect();
    const p = await inspectMigrations(db);
    expect(p).toMatchObject({ readOnly: true, mode: 'READ_ONLY_PLAN', sourceCount: 2, appliedCount: 0, productionLaunchApproved: false });
    expect(p.pending).toHaveLength(2);
    expect(p.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await tables(db)).toEqual([]);
    expect((await inspectMigrations(db)).planFingerprint).toBe(p.planFingerprint);
  });
  it('rejects missing backup acknowledgement and explicit approval before writes', async () => {
    const db = await connect(), p = await inspectMigrations(db);
    for (const value of [undefined, {}, { ...approval(p), backupVerified: false }, { ...approval(p), backupReference: '' }])
      await expect(applyMigrations(db, value)).rejects.toMatchObject({ code: 'EXPLICIT_APPROVAL_REQUIRED' });
    expect(await tables(db)).toEqual([]);
  });
  it('rejects a mismatched target without schema changes', async () => {
    const db = await connect(), p = await inspectMigrations(db);
    await expect(applyMigrations(db, { ...approval(p), expectedTarget: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'TARGET_MISMATCH' });
    expect(await tables(db)).toEqual([]);
  });
  it('rejects a plan produced for a different set of migration code', async () => {
    const before = await connect([First1700000000001]);
    const p = await inspectMigrations(before), after = await connect();
    await expect(applyMigrations(after, approval(p))).rejects.toMatchObject({ code: 'STALE_PLAN' });
    expect(await tables(after)).toEqual([]);
  });
  it('applies once and supports a fresh no-op plan but rejects an old plan', async () => {
    const db = await connect(), p = await inspectMigrations(db);
    const result = await applyMigrations(db, approval(p));
    expect(result.executed).toEqual(p.pending);
    expect(result.pending).toEqual([]);
    expect(await db.query('SELECT id,value,note FROM guard_example')).toEqual([{ id: 1, value: 'preserved', note: null }]);
    await expect(applyMigrations(db, approval(p))).rejects.toMatchObject({ code: 'STALE_PLAN' });
    const fresh = await inspectMigrations(db);
    expect((await applyMigrations(db, approval(fresh))).executed).toEqual([]);
    expect((await db.query('SELECT name FROM migrations')).length).toBe(2);
  });
  it('rolls back every schema change and releases the deployment lock on failure', async () => {
    const broken = await connect([First1700000000001, Failure1700000000002]);
    await expect(applyMigrations(broken, approval(await inspectMigrations(broken)))).rejects.toThrow();
    expect(await tables(broken)).toEqual([]);
    const corrected = await connect();
    expect((await applyMigrations(corrected, approval(await inspectMigrations(corrected)))).executed).toHaveLength(2);
  });
  it('allows only one executor and blocks planning during an in-progress migration', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const held = new Promise<void>(r => { release = r; });
    class Blocking1700000000003 {
      async up(r: QueryRunner) { enter(); await held; await r.query('CREATE TABLE guard_once(id integer)'); await r.query('INSERT INTO guard_once VALUES(1)'); }
      async down(r: QueryRunner) { await r.query('DROP TABLE guard_once'); }
    }
    const one = await connect([Blocking1700000000003]), two = await connect([Blocking1700000000003]);
    const p = await inspectMigrations(one);
    const first = applyMigrations(one, approval(p));
    // Observe rejection immediately so a setup failure is not unhandled.
    const settled = first.then((value: any) => ({ value }), (error: any) => ({ error }));
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Migration did not acquire its lock')), 5000); })]);
      await expect(applyMigrations(two, approval(p))).rejects.toMatchObject({ code: 'MIGRATION_BUSY' });
      await expect(inspectMigrations(two)).rejects.toMatchObject({ code: 'MIGRATION_BUSY' });
    } finally { clearTimeout(timer!); release(); }
    const result: { value?: any; error?: any } = await settled;
    expect(result.error).toBeUndefined();
    expect(await two.query('SELECT * FROM guard_once')).toEqual([{ id: 1 }]);
    expect((await two.query('SELECT name FROM migrations')).length).toBe(1);
    expect((await inspectMigrations(two)).pending).toEqual([]);
  }, 15000);
  it('refuses incomplete or unknown migration history rather than silently skipping it', async () => {
    const db = await connect();
    await applyMigrations(db, approval(await inspectMigrations(db)));
    await db.query('DELETE FROM migrations WHERE name=$1', ['First1700000000001']);
    await expect(inspectMigrations(db)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_DRIFT' });
    expect(await db.query('SELECT value FROM guard_example')).toEqual([{ value: 'preserved' }]);
  });
  it('refuses a populated schema without managed migration history', async () => {
    const db = await connect();
    await db.query('CREATE TABLE unrelated_data(id integer)');
    await expect(inspectMigrations(db)).rejects.toMatchObject({ code: 'UNMANAGED_SCHEMA' });
    expect(await tables(db)).toEqual([{ tablename: 'unrelated_data' }]);
  });
  it('upgrades the real six-migration baseline to the current set without changing existing user data', async () => {
    const latest = await connect(dataSourceOptions.migrations);
    const legacyTypes = latest.migrations.filter(m => Number((m.name || m.constructor.name).slice(-13)) <= 1789391000000).map(m => m.constructor);
    expect(legacyTypes).toHaveLength(6);
    const baseline = await connect(legacyTypes);
    expect((await baseline.runMigrations({ transaction: 'all' })).length).toBe(6);
    await baseline.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES('guard@example.invalid','synthetic',12345)`);
    const before = await baseline.query('SELECT id,email,nickname,"coinBalance"::text FROM users');
    const p = await inspectMigrations(latest);
    expect(p.appliedCount).toBe(6);
    expect(p.pending).toHaveLength(9);
    expect((await applyMigrations(latest, approval(p))).appliedCount).toBe(15);
    expect(await latest.query('SELECT id,email,nickname,"coinBalance"::text FROM users')).toEqual(before);
    expect((await inspectMigrations(latest)).pending).toEqual([]);
  });
  it('rejects invalid CLI flags without exposing secrets or connecting to the database', () => {
    const result = spawnSync(process.execPath, ['tools/release/migrations.cjs', '--unknown'], {
      encoding: 'utf8', env: { ...process.env, DB_PASSWORD: 'SYNTHETIC_SECRET_DO_NOT_LOG' }, timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('INVALID_ARGUMENTS');
    expect(result.stdout + result.stderr).not.toContain('SYNTHETIC_SECRET_DO_NOT_LOG');
  });
});
