'use strict';

// Operator-only deployment tool. It does not back up data or enable transactions.
const { createHash } = require('node:crypto');
const LOCK_KEYS = [1195463496, 1]; // Stable namespace; independent of commit/plan.
class MigrationGuardError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new MigrationGuardError(code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function supported(db) {
  const o = db.options;
  if (!db.isInitialized || o.type !== 'postgres' || o.synchronize || o.dropSchema ||
      o.migrationsRun || o.replication || (o.schema && o.schema !== 'public') ||
      (o.migrationsTableName && o.migrationsTableName !== 'migrations')) fail('UNSUPPORTED_DATABASE_CONFIG');
}
function sourceMigrations(db) {
  const rows = db.migrations.map(m => {
    const name = m.name || m.constructor.name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*\d{13}$/.test(name) || typeof m.up !== 'function' ||
        typeof m.down !== 'function' || m.transaction !== undefined) fail('UNSUPPORTED_MIGRATION');
    return { name, timestamp: Number(name.slice(-13)), codeHash: hash([String(m.up), String(m.down)]) };
  }).sort((a, b) => a.timestamp - b.timestamp);
  if (!rows.length || new Set(rows.map(r => r.name)).size !== rows.length ||
      new Set(rows.map(r => r.timestamp)).size !== rows.length) fail('INVALID_MIGRATION_SET');
  return rows;
}
async function planInTransaction(db, runner) {
  const source = sourceMigrations(db);
  const [identity] = await runner.query(`SELECT current_database() AS database,
    current_user AS username, current_schema() AS schema,
    inet_server_addr()::text AS address, inet_server_port() AS port`);
  if (identity.schema !== 'public') fail('UNSUPPORTED_SCHEMA');
  const [table] = await runner.query("SELECT to_regclass('public.migrations')::text AS relation");
  const applied = table.relation
    ? await runner.query('SELECT name,timestamp::text FROM public.migrations ORDER BY id') : [];
  if (!table.relation) {
    const [{ n }] = await runner.query(`SELECT count(*)::integer AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relkind IN ('r','p','v','m','S','f')`);
    if (n !== 0) fail('UNMANAGED_SCHEMA');
  }
  // A missing/unknown/out-of-order historical migration must not be skipped.
  if (applied.length > source.length || applied.some((r, i) =>
    r.name !== source[i].name || Number(r.timestamp) !== source[i].timestamp)) fail('MIGRATION_HISTORY_DRIFT');
  const targetFingerprint = hash({ configuredHost: db.options.host || null,
    configuredPort: db.options.port || 5432, ...identity });
  const planFingerprint = hash({ targetFingerprint, source, applied });
  return {
    contract: 'GUARDED_MIGRATIONS_V1', targetFingerprint, planFingerprint,
    sourceCount: source.length, appliedCount: applied.length,
    applied: applied.map(r => r.name), pending: source.slice(applied.length).map(r => r.name),
    productionLaunchApproved: false,
  };
}
async function inspectMigrations(db) {
  supported(db);
  const runner = db.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');
    await runner.query('SET TRANSACTION READ ONLY');
    await runner.query("SET LOCAL statement_timeout = '15000ms'");
    const [{ acquired }] = await runner.query(
      'SELECT pg_try_advisory_xact_lock_shared($1::integer,$2::integer) AS acquired', LOCK_KEYS);
    if (!acquired) fail('MIGRATION_BUSY');
    const plan = await planInTransaction(db, runner);
    const [{ readOnly }] = await runner.query("SELECT current_setting('transaction_read_only') AS \"readOnly\"");
    await runner.commitTransaction();
    return { ...plan, mode: 'READ_ONLY_PLAN', readOnly: readOnly === 'on' };
  } finally {
    try { if (runner.isTransactionActive) await runner.rollbackTransaction(); }
    finally { await runner.release(); }
  }
}
async function applyMigrations(db, approval) {
  supported(db);
  if (!approval || !sha(approval.expectedTarget) || !sha(approval.expectedPlan) ||
      approval.backupVerified !== true || typeof approval.backupReference !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(approval.backupReference)) fail('EXPLICIT_APPROVAL_REQUIRED');
  const runner = db.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    await runner.query("SET LOCAL lock_timeout = '5000ms'");
    await runner.query("SET LOCAL statement_timeout = '120000ms'");
    const [{ acquired }] = await runner.query(
      'SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired', LOCK_KEYS);
    if (!acquired) fail('MIGRATION_BUSY');
    // Re-read target and history after obtaining the exclusive deployment lock.
    const before = await planInTransaction(db, runner);
    if (approval.expectedTarget !== before.targetFingerprint) fail('TARGET_MISMATCH');
    if (approval.expectedPlan !== before.planFingerprint) fail('STALE_PLAN');
    const { MigrationExecutor } = require('typeorm');
    const executor = new MigrationExecutor(db, runner);
    executor.transaction = 'all';
    executor.fake = false;
    const applied = await executor.executePendingMigrations();
    const after = await planInTransaction(db, runner);
    if (after.pending.length) fail('INCOMPLETE_MIGRATION');
    await runner.commitTransaction();
    return { ...after, mode: 'APPLIED', executed: applied.map(m => m.name),
      backupReference: approval.backupReference, backupVerification: 'OPERATOR_ATTESTED_NOT_PERFORMED_BY_TOOL' };
  } finally {
    try { if (runner.isTransactionActive) await runner.rollbackTransaction(); }
    finally { await runner.release(); }
  }
}
async function cli(args = process.argv.slice(2), env = process.env) {
  if (args.length > 1 || (args[0] && !['--plan','--apply','--check-ready'].includes(args[0]))) fail('INVALID_ARGUMENTS');
  const mode = args[0] || '--plan';
  // Never import the server entry point or a seed script.
  require('reflect-metadata');
  require('dotenv').config({ quiet: true });
  if (['DB_HOST','DB_USERNAME','DB_PASSWORD','DB_DATABASE'].some(k => !env[k]) ||
      !/^\d+$/.test(env.DB_PORT || '') || Number(env.DB_PORT) < 1 || Number(env.DB_PORT) > 65535) fail('DATABASE_CONFIG_REQUIRED');
  const { DataSource } = require('typeorm');
  const { dataSourceOptions } = require('../../dist/config/typeorm.config.js');
  const silent = { logQuery() {}, logQueryError() {}, logQuerySlow() {}, logSchemaBuild() {}, logMigration() {}, log() {} };
  const db = new DataSource({ ...dataSourceOptions, synchronize: false, migrationsRun: false,
    dropSchema: false, logging: false, logger: silent,
    extra: { max: 1, connectionTimeoutMillis: 10000 } });
  try {
    await db.initialize();
    const result = mode === '--apply' ? await applyMigrations(db, {
      expectedTarget: env.RELEASE_EXPECTED_TARGET, expectedPlan: env.RELEASE_EXPECTED_PLAN,
      backupVerified: env.RELEASE_BACKUP_VERIFIED === 'true', backupReference: env.RELEASE_BACKUP_REFERENCE,
    }) : await inspectMigrations(db);
    console.log(JSON.stringify(result));
    if (mode === '--check-ready' && result.pending.length) fail('MIGRATIONS_PENDING');
    return result;
  } finally { if (db.isInitialized) await db.destroy(); }
}
module.exports = { inspectMigrations, applyMigrations, MigrationGuardError, LOCK_KEYS, cli };
if (require.main === module) cli().catch(error => {
  console.error(JSON.stringify({ status: 'BLOCKED', code: error instanceof MigrationGuardError ? error.code : 'DATABASE_OPERATION_FAILED' }));
  process.exitCode = 1; // Do not expose DB credentials, SQL values, or raw exception stacks.
});
