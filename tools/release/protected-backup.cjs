'use strict';
// Operator-side encrypted export. No restore, schema change, or live CI access.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
class BackupError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new BackupError(code); };
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const quote = x => '"' + x.replace(/"/g, '""') + '"';
const runtimeEnv = () => Object.fromEntries(['PATH','SystemRoot','WINDIR','LANG','LC_ALL','TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
function configuration(env) {
  if (!/^[a-zA-Z0-9.-]+$/.test(env.DB_HOST || '') || !/^\d+$/.test(env.DB_PORT || '') ||
      Number(env.DB_PORT) < 1 || Number(env.DB_PORT) > 65535 ||
      !/^[a-zA-Z0-9_-]+$/.test(env.DB_DATABASE || '') || !/^[a-zA-Z0-9_-]+$/.test(env.DB_USERNAME || '') || !env.DB_PASSWORD)
    fail('DATABASE_CONFIG_REQUIRED');
  const local = env.DB_HOST === '127.0.0.1';
  if (local && !(env.CI === 'true' && env.NODE_ENV === 'test' && env.TEST_POSTGRES === 'true' && /^gacha_backup_[a-f0-9]+$/.test(env.DB_DATABASE)))
    fail('LOCAL_SOURCE_IS_TEST_ONLY');
  if (!local && !/^dpg-[a-z0-9-]+\.(singapore|oregon|ohio|virginia|frankfurt)-postgres\.render\.com$/.test(env.DB_HOST))
    fail('RENDER_EXTERNAL_HOST_REQUIRED');
  return { host: env.DB_HOST, port: Number(env.DB_PORT), database: env.DB_DATABASE,
    user: env.DB_USERNAME, password: env.DB_PASSWORD,
    ssl: local ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000, query_timeout: 120000,
    application_name: 'gachigacha-protected-backup',
    options: '-c default_transaction_read_only=on -c statement_timeout=120000' };
}
function validateDestination(directory, recipient) {
  if (!/^age1[0-9a-z]{58}$/.test(recipient || '')) fail('AGE_PUBLIC_RECIPIENT_REQUIRED');
  if (!path.isAbsolute(directory || '') || process.platform === 'win32') fail('PRIVATE_POSIX_DIRECTORY_REQUIRED');
  const actual = fs.realpathSync(directory), stat = fs.lstatSync(directory);
  const repo = fs.realpathSync(path.resolve(__dirname, '../..'));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid()) || actual === repo || actual.startsWith(repo + path.sep))
    fail('UNSAFE_BACKUP_DIRECTORY');
  return actual;
}
async function identity(client, config) {
  const { rows: [r] } = await client.query(`SELECT current_database() AS database,current_user AS role,
    current_setting('server_version_num')::integer AS version,
    current_setting('transaction_read_only') AS read_only,
    COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS ssl`);
  if (r.read_only !== 'on' || r.database !== config.database || r.role !== config.user) fail('SOURCE_IDENTITY_MISMATCH');
  if (config.host !== '127.0.0.1' && !r.ssl) fail('VERIFIED_TLS_REQUIRED');
  if (Math.floor(r.version / 10000) !== 18) fail('POSTGRES18_REQUIRED');
  return { targetFingerprint: digest([config.host,config.port,r.database,r.role,18]), serverMajor: 18,
    readOnly: true, encryptedTransport: r.ssl };
}
async function inspectSource(client, config) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try { const result = await identity(client, config); await client.query('COMMIT'); return { ...result, mode: 'READ_ONLY_PLAN', backupCreated: false }; }
  catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
}
function command(file, args, env) {
  const p = spawn(file, args, { env, stdio: ['pipe','pipe','pipe'], timeout: 120000, killSignal: 'SIGKILL' });
  let diagnostic = false;
  p.stderr.on('data', () => { diagnostic = true; }); // Never log raw DB/tool errors.
  p.done = new Promise(resolve => {
    p.once('error', () => resolve({ ok: false, diagnostic: true }));
    p.once('close', (code, signal) => resolve({ ok: code === 0 && !signal, diagnostic }));
  });
  return p;
}
function nativeDump(args, config) {
  return command('pg_dump', args, { ...runtimeEnv(), PGHOST: config.host, PGPORT: String(config.port),
    PGDATABASE: config.database, PGUSER: config.user, PGPASSWORD: config.password,
    PGSSLMODE: config.host === '127.0.0.1' ? 'disable' : 'verify-full',
    ...(config.host === '127.0.0.1' ? {} : { PGSSLROOTCERT: 'system' }),
    PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=120000' });
}
async function checksum(file) {
  const h = createHash('sha256'); let bytes = 0;
  for await (const data of fs.createReadStream(file)) { h.update(data); bytes += data.length; }
  return { sha256: h.digest('hex'), bytes };
}
async function createBackup(client, config, approval, dumpFactory = nativeDump) {
  const directory = validateDestination(approval.directory, approval.recipient);
  if (!/^[a-f0-9]{64}$/.test(approval.expectedTarget || '')) fail('TARGET_APPROVAL_REQUIRED');
  const id = randomUUID(), file = path.join(directory, id + '.dump.age');
  const partial = file + '.partial', manifestPath = file + '.json';
  let dump, encryption, output, fd, committed = false;
  let partialCreated = false, finalCreated = false, manifestCreated = false;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const source = await identity(client, config);
    if (source.targetFingerprint !== approval.expectedTarget) fail('TARGET_MISMATCH');
    const { rows: [{ snapshot }] } = await client.query('SELECT pg_export_snapshot() AS snapshot');
    if (!/^[a-zA-Z0-9-]+$/.test(snapshot)) fail('INVALID_SNAPSHOT');
    const { rows: tables } = await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p')
      AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname`);
    if (tables.length > 250) fail('TABLE_LIMIT_REQUIRES_MANUAL_REVIEW');
    const counts = [];
    for (const t of tables) {
      const { rows: [{ count }] } = await client.query(`SELECT count(*)::text AS count FROM ${quote(t.schema)}.${quote(t.name)}`);
      counts.push({ ...t, count });
    }
    fd = fs.openSync(partial, 'wx', 0o600); partialCreated = true;
    output = fs.createWriteStream(partial, { fd, autoClose: false });
    encryption = command('age', ['--encrypt','--recipient',approval.recipient], runtimeEnv());
    dump = await dumpFactory(['--format=custom','--no-password','--lock-wait-timeout=5000','--snapshot=' + snapshot], config);
    // Both processes and both streams must succeed. Plain dump bytes never reach a file or log.
    const transfers = [pipeline(dump.stdout, encryption.stdin), pipeline(encryption.stdout, output)];
    const all = await Promise.allSettled(transfers);
    if (all.some(r => r.status === 'rejected')) { dump.kill('SIGKILL'); encryption.kill('SIGKILL'); }
    const statuses = await Promise.all([dump.done, encryption.done]);
    if (all.some(r => r.status === 'rejected') || statuses.some(s => !s.ok)) fail('ENCRYPTED_EXPORT_FAILED');
    if (statuses.some(s => s.diagnostic)) fail('TOOL_DIAGNOSTICS_REQUIRE_PRIVATE_REVIEW');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const integrity = await checksum(partial);
    if (!integrity.bytes) fail('EMPTY_EXPORT');
    const manifest = { contract: 'PROTECTED_POSTGRES_EXPORT_V1', createdAt: new Date().toISOString(),
      ...source, archive: path.basename(file), ...integrity, encryption: 'age-X25519',
      recipientFingerprint: digest(approval.recipient), snapshotConsistentCounts: counts,
      format: 'pg_dump-custom', scope: 'single database; cluster roles and external objects not included',
      restoreVerified: false, productionLaunchApproved: false };
    await client.query('COMMIT'); committed = true;
    // Link, rather than rename, prevents overwriting any existing final file.
    fs.linkSync(partial, file); finalCreated = true; fs.unlinkSync(partial); partialCreated = false;
    const manifestFd = fs.openSync(manifestPath, 'wx', 0o600); manifestCreated = true;
    try { fs.writeFileSync(manifestFd, JSON.stringify(manifest,null,2) + '\n'); fs.fsyncSync(manifestFd); } finally { fs.closeSync(manifestFd); }
    return { archivePath: file, manifestPath, manifest };
  } catch (e) {
    if (dump) dump.kill('SIGKILL'); if (encryption) encryption.kill('SIGKILL');
    if (output) output.destroy();
    await Promise.all([dump?.done,encryption?.done].filter(Boolean));
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    for (const [p, owned] of [[partial,partialCreated],[file,finalCreated],[manifestPath,manifestCreated]]) { if (owned) { try { fs.unlinkSync(p); } catch {} } }
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
async function cli(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 1 || !['--plan','--create'].includes(args[0])) fail('USE_PLAN_OR_CREATE');
  const config = configuration(env);
  if (args[0] === '--create') validateDestination(env.BACKUP_DIRECTORY, env.BACKUP_AGE_RECIPIENT);
  const { Client } = require('pg'); const client = new Client(config);
  try {
    await client.connect();
    const result = args[0] === '--plan' ? await inspectSource(client, config) : await createBackup(client, config, {
      expectedTarget: env.BACKUP_EXPECTED_TARGET, directory: env.BACKUP_DIRECTORY, recipient: env.BACKUP_AGE_RECIPIENT });
    // Paths, table counts and credentials stay in the operator's private manifest.
    console.log(JSON.stringify(args[0] === '--plan' ? result : { mode: 'ENCRYPTED_EXPORT_CREATED',
      targetFingerprint: result.manifest.targetFingerprint, sha256: result.manifest.sha256,
      bytes: result.manifest.bytes, restoreVerified: false, productionLaunchApproved: false }));
  } finally { await client.end().catch(() => {}); }
}
module.exports = { BackupError, configuration, validateDestination, inspectSource, createBackup, command, runtimeEnv, checksum, cli };
if (require.main === module) cli().catch(e => { console.error(JSON.stringify({ status: 'BLOCKED', code: e instanceof BackupError ? e.code : 'BACKUP_OPERATION_FAILED' })); process.exitCode = 1; });
