'use strict';

// Read-only pre-deploy verification. Never imports the old operator bootstrap,
// runs a migration, creates fixtures, starts the API, or changes DB access.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { compareRows } = require('./schema-compare.cjs');
const { assertStagingTarget } = require('./staging-target.cjs');
const baseline = require('./schema-baseline.json');

async function cli(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 1 || !args[0].startsWith('--workspace=')) throw new Error('WORKSPACE_REQUIRED');
  const target = assertStagingTarget(env, args[0].slice('--workspace='.length));
  const root = path.resolve(__dirname, '../..');
  const sourceFiles = fs.readdirSync(path.join(root, 'src/database/migrations')).filter(f => f.endsWith('.ts')).sort();
  if (JSON.stringify(sourceFiles) !== JSON.stringify(Object.keys(baseline.migrationSourceHashes).sort())) {
    throw new Error('MIGRATION_SOURCE_SET_CHANGED');
  }
  for (const [file, expectedHash] of Object.entries(baseline.migrationSourceHashes)) {
    const actualHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'src/database/migrations', file))).digest('hex');
    if (actualHash !== expectedHash) throw new Error('MIGRATION_SOURCE_CHANGED');
  }
  const client = new Client({ host: target.hostname, port: 5432, database: target.databaseName,
    user: target.username, password: env.DB_PASSWORD, connectionTimeoutMillis: 10000 });
  const results = {};
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15000ms'");
    const { rows: [identity] } = await client.query("SELECT current_database() AS database,current_user AS username,current_setting('transaction_read_only') AS read_only");
    if (identity.database !== target.databaseName || identity.username !== target.username || identity.read_only !== 'on') {
      throw new Error('ACTUAL_DB_IDENTITY_MISMATCH');
    }
    for (const [kind, query] of Object.entries(baseline.queries)) {
      if (!/^SELECT\s/i.test(query)) throw new Error('NON_SELECT_CATALOG_QUERY');
      const { rows } = await client.query(query);
      const result = compareRows(baseline.expected[kind], rows);
      if (!result.equal) {
        console.error(JSON.stringify({ event: 'SCHEMA_DRIFT', kind, ...result }));
        throw new Error('SOURCE_SCHEMA_MISMATCH');
      }
      results[kind] = { count: result.actualCount, hash: result.actualHash };
    }
    await client.query('COMMIT');
  } finally { await client.end(); }

  // Existing history/fingerprint inspection is read-only. No --apply path exists.
  const plan = spawnSync(process.execPath, [path.join(__dirname, 'migrations.cjs'), '--plan'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 2000000 });
  if (plan.status !== 0) throw new Error('READ_ONLY_MIGRATION_PLAN_FAILED');
  const history = JSON.parse(plan.stdout.trim().split('\n').findLast(line => line.startsWith('{')));
  if (!history.readOnly || history.appliedCount !== 15 || history.sourceCount !== 15 || history.pending.length !== 0) {
    throw new Error('MIGRATION_HISTORY_NOT_READY');
  }
  console.log(JSON.stringify({ event: 'STAGING_SCHEMA_VERIFIED', readOnly: true, schemaDrift: false,
    migrationApplied: false, applied: history.appliedCount, pending: history.pending.length,
    targetFingerprint: history.targetFingerprint, planFingerprint: history.planFingerprint, results }));
}

module.exports = { cli };
if (require.main === module) cli().catch(error => {
  // Raw driver errors can include credentials or operational details.
  const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'READ_ONLY_SCHEMA_VERIFICATION_FAILED';
  console.error(JSON.stringify({ status: 'BLOCKED', code }));
  process.exitCode = 1;
});
