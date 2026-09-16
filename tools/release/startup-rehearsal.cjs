'use strict';
// Compiled real AppModule/HTTP server; isolated local databases and synthetic data.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHmac, createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function guardedSettings(env) {
  assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.TEST_POSTGRES, 'true');
  assert.equal(env.CI_REHEARSAL, 'true');
  assert.match(env.REHEARSAL_PG_CONTAINER || '', /^[a-f0-9]{12,64}$/);
  assert(!fs.existsSync(path.join(root, '.env')), 'Isolated checkout without .env required');
  const port = Number(env.TEST_POSTGRES_PORT || '5432');
  assert(Number.isInteger(port) && port > 0 && port <= 65535);
  return { type: 'postgres', host: '127.0.0.1', port, username: 'gacha_ci',
    password: 'local-ci-only', ssl: false, synchronize: false, logging: false,
    extra: { max: 4, connectionTimeoutMillis: 10000, statement_timeout: 15000 } };
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function tokenFor(user, secret) {
  const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
  const value = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ sub: user, av: 0,
    role: 'OWNER', exp: Math.floor(Date.now()/1000) + 600 }); // Forged role must be ignored.
  return value + '.' + createHmac('sha256', secret).update(value).digest('base64url');
}
async function main() {
  const local = guardedSettings(process.env);
  require('reflect-metadata');
  const { DataSource } = require('typeorm');
  const { dataSourceOptions } = require('../../dist/config/typeorm.config.js');
  const { LOCK_KEYS } = require('./migrations.cjs');
  const { loadProbability } = require('../../dist/modules/orders/probability.js');
  const resultDir = path.join(root, 'rehearsal-results');
  fs.mkdirSync(resultDir, { recursive: true });
  const report = { contract: 'FULL_PROCESS_STARTUP_REHEARSAL_V1', status: 'RUNNING',
    checkedCommit: execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    startedAt: new Date().toISOString(), source: 'GENERATED_SYNTHETIC_DATA',
    liveRenderDatabaseAccessed: false, realPaymentAttempted: false, checks: [] };
  const pass = (name, details = {}) => { report.checks.push({ name, status: 'PASS', ...details }); console.log('PASS ' + name); };
  const suffix = randomUUID().replace(/-/g, '');
  const names = ['empty','source','restore'].map(n => 'gacha_startup_' + n + '_' + suffix);
  const created = [], connections = [], processes = [];
  const admin = new DataSource({ ...local, database: 'postgres' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-startup-'));
  const jwtSecret = randomBytes(48).toString('hex');
  let log = '';
  const envFor = async database => ({ PATH: process.env.PATH, HOME: process.env.HOME,
    LANG: 'C.UTF-8', TZ: 'UTC', NODE_ENV: 'production',
    DB_HOST: '127.0.0.1', DB_PORT: String(local.port), DB_USERNAME: 'gacha_ci',
    DB_PASSWORD: 'local-ci-only', DB_DATABASE: database, PORT: String(await freePort()),
    JWT_SECRET: jwtSecret, ENABLE_LEGACY_TRANSACTIONS: 'false',
    ENABLE_GP_ORDER_PREVIEW: 'true', ENABLE_SHIPPING_PREVIEW: 'true',
    ENABLE_GP_CONVERSION_PREVIEW: 'true', ENABLE_ORDER_REFUND_PREVIEW: 'true',
    ENABLE_DANAL_TEST_PAYMENTS: 'true', ENABLE_OPERATIONS_PREVIEW: 'true' });
  function launch(env, script = 'tools/release/start.cjs', args = []) {
    const child = spawn(process.execPath, [path.join(root,script), ...args], {
      cwd: root, env, stdio: ['ignore','pipe','pipe'], shell: false,
    });
    const p = { child, text: '', finished: false, result: null };
    processes.push(p);
    const collect = bytes => { p.text += bytes.toString(); if (p.text.length > 2*1024*1024) child.kill('SIGKILL'); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    p.exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close',(code, signal) => { p.finished = true; p.result = { code, signal }; log += '\n--- ' + script + ' ---\n' + p.text; resolve(p.result); });
    });
    p.exit.catch(() => {});
    return p;
  }
  async function exitOf(p, ms=20000) {
    let timer;
    try { return await Promise.race([p.exit, new Promise((_,reject) => {
      timer = setTimeout(() => { p.child.kill('SIGKILL'); reject(new Error('Child process timeout')); },ms);
    })]); } finally { clearTimeout(timer); }
  }
  async function blocked(env, code, args = []) {
    const p = launch(env, undefined, args);
    assert.equal((await exitOf(p)).code, 1);
    assert(p.text.includes(code), 'Missing expected blocking reason: ' + code);
    assert(!p.text.includes('START_GATE_PASSED'));
    assert(!p.text.includes(jwtSecret));
    return p;
  }
  async function request(env, route, token, method='GET', body) {
    const response = await fetch('http://127.0.0.1:' + env.PORT + route, {
      method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}),
        'content-type': 'application/json', 'idempotency-key': randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, body: await response.json() };
  }
  async function ready(p, env) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !p.finished) {
      try { const r = await request(env,'/health/ready'); if (r.status === 200) return r; } catch {}
      await delay(100);
    }
    throw new Error('Compiled app did not become ready');
  }
  async function connect(database, migrations) {
    const db = new DataSource({ ...dataSourceOptions, ...local, database,
      ...(migrations ? { migrations } : {}) });
    connections.push(db); await db.initialize(); return db;
  }
  const state = async db => (await db.query(`SELECT
    (SELECT count(*)::integer FROM users) AS users,
    (SELECT coalesce(sum("coinBalance"),0)::text FROM users) AS gp,
    (SELECT count(*)::integer FROM gachas) AS boxes,
    (SELECT count(*)::integer FROM items) AS prizes,
    (SELECT count(*)::integer FROM capsule_orders) AS orders,
    (SELECT count(*)::integer FROM owned_capsules) AS capsules,
    (SELECT count(*)::integer FROM wallet_transactions) AS ledger`))[0];
  try {
    await admin.initialize();
    report.postgresVersion = (await admin.query("SELECT current_setting('server_version') AS version"))[0].version;
    assert.equal(Number(report.postgresVersion.split('.')[0]), 18);
    for (const name of names) { await admin.query('CREATE DATABASE "' + name + '" TEMPLATE template0'); created.push(name); }
    const empty = await connect(names[0]);
    const emptyEnv = await envFor(names[0]);
    await blocked(emptyEnv, 'INVALID_START_ARGUMENTS', ['--apply']);
    await blocked({ ...emptyEnv, JWT_SECRET: 'short' }, 'JWT_SECRET_REQUIRED');
    await blocked({ ...emptyEnv, PORT: '0' }, 'INVALID_PORT');
    pass('invalid_start_configuration_is_rejected_without_server_launch');
    await blocked(emptyEnv, 'MIGRATIONS_PENDING');
    assert.deepEqual(await empty.query("SELECT tablename FROM pg_tables WHERE schemaname='public'"), []);
    pass('empty_database_blocks_start_without_creating_tables');
    const legacy = empty.migrations.filter(m => Number((m.name || m.constructor.name).slice(-13)) <= 1789391000000).map(m => m.constructor);
    assert.equal(legacy.length, 6);
    const source = await connect(names[1], legacy);
    await source.runMigrations({ transaction: 'all' });
    const [user] = await source.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES('startup@example.invalid','startup-fixture',10000) RETURNING id`);
    const [box] = await source.query(`INSERT INTO gachas(title,price,currency,"totalStock") VALUES('startup-fixture',100,'GP',1) RETURNING id`);
    const [item] = await source.query(`INSERT INTO items(name,"estimatedValue","isPremium","conversionGP") VALUES('startup-prize',1000,false,100) RETURNING id`);
    await source.query('INSERT INTO gacha_items(gacha_id,item_id,"probabilityPpm") VALUES($1,$2,1000000)',[box.id,item.id]);
    const baseline = await state(source);
    const dumpPath = path.join(tmp,'synthetic.dump');
    const fd = fs.openSync(dumpPath,'wx',0o600);
    try { execFileSync('docker',['exec',process.env.REHEARSAL_PG_CONTAINER,'pg_dump','--username=gacha_ci','--format=custom',names[1]],{ stdio:['ignore',fd,'pipe'], timeout:60000 }); }
    finally { fs.closeSync(fd); }
    const dump = fs.readFileSync(dumpPath);
    execFileSync('docker',['exec','-i',process.env.REHEARSAL_PG_CONTAINER,'pg_restore','--username=gacha_ci','--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname='+names[2]],{ input:dump,timeout:60000 });
    const target = await connect(names[2]);
    assert.deepEqual(await state(target),baseline);
    pass('synthetic_legacy_backup_restored',{ archiveSha256:createHash('sha256').update(dump).digest('hex') });
    const env = await envFor(names[2]);
    await blocked(env, 'MIGRATIONS_PENDING');
    assert.equal((await target.query('SELECT name FROM migrations')).length,6);
    assert.deepEqual(await state(target),baseline);
    pass('six_migration_database_blocks_start_without_mutating_fixtures');
    const planner = launch(env,'tools/release/migrations.cjs',['--plan']);
    assert.equal((await exitOf(planner)).code,0);
    const plan = JSON.parse(planner.text.trim().split('\n').at(-1));
    assert.equal(plan.pending.length,9); assert.equal(plan.readOnly,true);
    const locked = target.createQueryRunner();
    try {
      await locked.connect(); await locked.startTransaction();
      await locked.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)',LOCK_KEYS);
      await blocked(env,'MIGRATION_BUSY');
    } finally { if(locked.isTransactionActive) await locked.rollbackTransaction(); await locked.release(); }
    pass('in_progress_migration_blocks_server_start');
    // Attestation below refers ONLY to the synthetic archive restored above.
    const approvalEnv = { ...env, RELEASE_EXPECTED_TARGET:plan.targetFingerprint,
      RELEASE_EXPECTED_PLAN:plan.planFingerprint, RELEASE_BACKUP_VERIFIED:'true',
      RELEASE_BACKUP_REFERENCE:'SYNTHETIC_LOCAL_DUMP_RESTORED' };
    const migration = launch(approvalEnv,'tools/release/migrations.cjs',['--apply']);
    assert.equal((await exitOf(migration)).code,0);
    const applied = JSON.parse(migration.text.trim().split('\n').at(-1));
    assert.equal(applied.executed.length,9); assert.equal(applied.appliedCount,15);
    assert.deepEqual(await state(target),baseline);
    pass('guarded_cli_upgrades_restored_fixture_from_six_to_fifteen');
    const server = launch(approvalEnv);
    assert.equal((await ready(server,env)).body.data.status,'ready');
    assert.equal((await request(env,'/health')).body.data.status,'ok');
    pass('real_compiled_app_starts_and_reports_database_ready');
    const token = tokenFor(user.id,jwtSecret);
    assert.equal((await request(env,'/capsules')).status,401);
    assert.equal((await request(env,'/owner/capabilities')).status,401);
    assert.equal((await request(env,'/owner/capabilities',token)).status,403);
    assert.equal((await request(env,'/capsules',token)).status,200);
    pass('real_http_authentication_and_owner_permission_boundaries_hold');
    const odds = await loadProbability(target.manager,box.id);
    const result = await request(env,'/orders/gp',token,'POST',{
      gachaId:box.id,quantity:1,expectedUnitPrice:100,expectedProbabilityVersion:odds.version,
    });
    assert.equal(result.status,503);
    assert.deepEqual(await state(target),baseline);
    pass('production_gp_purchase_stays_disabled_even_with_preview_flags');
    await target.query("INSERT INTO migrations(timestamp,name) VALUES(1999999999999,'Unexpected1999999999999')");
    const drift = await request(env,'/health/ready');
    assert.equal(drift.status,503); assert.equal((await request(env,'/health')).status,200);
    assert(!JSON.stringify(drift.body).includes(names[2]));
    assert(!JSON.stringify(drift.body).includes('Unexpected1999999999999'));
    pass('runtime_schema_drift_is_not_misreported_as_healthy');
    server.child.kill('SIGTERM');
    assert.equal((await exitOf(server,15000)).code,143);
    await assert.rejects(request(env,'/health'));
    pass('termination_reaches_app_child_and_closes_http_listener');
    await blocked(env,'MIGRATION_HISTORY_DRIFT');
    await target.query('DELETE FROM migrations WHERE name=$1',['Unexpected1999999999999']);
    const restarted = launch(env);
    await ready(restarted,env);
    assert.deepEqual(await state(target),baseline);
    restarted.child.kill('SIGTERM');
    assert.equal((await exitOf(restarted,15000)).code,143);
    assert.equal((await target.query('SELECT name FROM migrations')).length,15);
    pass('restart_performs_no_seeding_or_automatic_migration');
    report.status='PASS';
  } catch(error) {
    report.status='FAIL'; report.failure={ name:error.name,message:error.message }; process.exitCode=1;
  } finally {
    try {
      for(const p of processes) if(!p.finished) { p.child.kill('SIGTERM'); await exitOf(p,15000); }
      for(const db of connections) if(db.isInitialized) await db.destroy();
      if(admin.isInitialized) {
        for(const name of created) await admin.query('DROP DATABASE "'+name+'"');
        await admin.destroy();
      }
      fs.rmSync(tmp,{ recursive:true,force:true }); report.cleanup='PASS';
    } catch(error) { report.status='FAIL'; report.cleanup='FAIL'; report.cleanupError=error.message; process.exitCode=1; }
    report.finishedAt=new Date().toISOString();
    log=log.split(jwtSecret).join('[REDACTED_SYNTHETIC_SECRET]');
    fs.writeFileSync(path.join(resultDir,'startup-report.json'),JSON.stringify(report,null,2)+'\n');
    fs.writeFileSync(path.join(resultDir,'startup-execution.log'),log);
    console.log('STARTUP_REHEARSAL_RESULT='+report.status);
  }
}
main().catch(error=>{ console.error(error.message); process.exitCode=1; });
