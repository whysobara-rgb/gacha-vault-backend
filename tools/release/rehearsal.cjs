'use strict';

// Synthetic rehearsal only. Never accepts a remote database URL or credentials.
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function settings(env) {
  assert.equal(env.NODE_ENV, 'test', 'NODE_ENV=test required');
  assert.equal(env.TEST_POSTGRES, 'true', 'TEST_POSTGRES=true required');
  assert.equal(env.CI_REHEARSAL, 'true', 'CI_REHEARSAL=true required');
  assert.match(env.REHEARSAL_PG_CONTAINER || '', /^[a-f0-9]{12,64}$/, 'Dedicated local Docker container required');
  const port = Number(env.TEST_POSTGRES_PORT || '5432');
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid test port');
  return {
    type: 'postgres', host: '127.0.0.1', port,
    username: 'gacha_ci', password: 'local-ci-only',
    ssl: false, synchronize: false, logging: false,
    extra: { max: 60, connectionTimeoutMillis: 15000, statement_timeout: 15000 },
  };
}
function identifier(value) {
  assert.match(value, /^[a-z_][a-z0-9_]*$/i, 'Unsafe SQL identifier');
  return '"' + value + '"';
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function selfTest() {
  const good = { NODE_ENV: 'test', TEST_POSTGRES: 'true', CI_REHEARSAL: 'true', REHEARSAL_PG_CONTAINER: 'a'.repeat(64) };
  assert.equal(settings({ ...good, DB_HOST: 'remote.invalid', DATABASE_URL: 'postgres://remote.invalid/x' }).host, '127.0.0.1');
  for (const key of ['NODE_ENV', 'TEST_POSTGRES', 'CI_REHEARSAL', 'REHEARSAL_PG_CONTAINER']) {
    assert.throws(() => settings({ ...good, [key]: '' }));
  }
  for (const port of ['0', '65536', 'NaN', '1.5']) assert.throws(() => settings({ ...good, TEST_POSTGRES_PORT: port }));
  assert.equal(identifier('coinBalance'), '"coinBalance"');
  assert.throws(() => identifier('x; DROP DATABASE y'));
  assert.equal(digest({ b: 1, a: { d: 2, c: 3 } }), digest({ a: { c: 3, d: 2 }, b: 1 }));
  console.log('Rehearsal guard and canonicalization self-test passed (no database accessed).');
}

async function main() {
  const options = settings(process.env); // Reject before loading app or DB packages.
  require('reflect-metadata');
  const { DataSource } = require('typeorm');
  const compiled = file => require(path.resolve(__dirname, '../../dist', file));
  const { dataSourceOptions } = compiled('config/typeorm.config.js');
  const { probabilityVersion } = compiled('modules/orders/probability.js');
  const { OrdersService } = compiled('modules/orders/orders.service.js');
  const migrationDir = path.resolve(__dirname, '../../dist/database/migrations');
  const migrations = fs.readdirSync(migrationDir).filter(n => /^\d{13}-.+\.js$/.test(n)).sort().map(n => ({
    file: n, ctor: Object.values(require(path.join(migrationDir, n))).find(v => typeof v === 'function' && v.prototype?.up),
  }));
  assert(migrations.every(m => m.ctor), 'Missing compiled migration class');
  const legacy = migrations.filter(m => Number(m.file.slice(0, 13)) <= 1789391000000);
  assert.equal(legacy.length, 6, 'Baseline must contain the original six migrations');
  assert(migrations.length >= 15, 'Latest migration set is incomplete');
  const reportDir = path.resolve(__dirname, '../../rehearsal-results');
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), status: 'RUNNING',
    source: 'GENERATED_SYNTHETIC_DATA', liveRenderDatabaseAccessed: false,
    realPaymentAttempted: false, checks: [],
    checkedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    nodeVersion: process.version,
  };
  const checked = (name, details = {}) => {
    report.checks.push({ name, status: 'PASS', ...details });
    console.log('PASS ' + name + ' ' + JSON.stringify(details));
  };
  const suffix = randomUUID().replace(/-/g, '');
  const sourceName = 'gacha_rehearsal_source_' + suffix;
  const targetName = 'gacha_rehearsal_restore_' + suffix;
  const createdDatabases = [];
  const admin = new DataSource({ ...options, database: 'postgres' });
  let source, target, app;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-synthetic-'));
  const makeDb = (database, selectedMigrations) => new DataSource({
    ...options, database, entities: dataSourceOptions.entities,
    migrations: selectedMigrations.map(m => m.ctor),
  });
  async function columns(db) {
    const rows = await db.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`);
    const result = {};
    for (const r of rows) (result[r.table_name] ||= []).push(r.column_name);
    return result;
  }
  async function records(db, fields) {
    const result = {};
    for (const [table, names] of Object.entries(fields)) {
      const projection = names.map(identifier).join(',');
      const rows = await db.query(`SELECT to_jsonb(t) AS row FROM (SELECT ${projection} FROM public.${identifier(table)}) t ORDER BY to_jsonb(t)::text`);
      result[table] = { count: rows.length, digest: digest(rows.map(r => r.row)) };
    }
    return result;
  }
  async function sequences(db, names) {
    return db.query(`SELECT sequencename,last_value::text,increment_by::text FROM pg_sequences WHERE schemaname='public' AND sequencename=ANY($1::text[]) ORDER BY sequencename`, [names]);
  }
  try {
    await admin.initialize();
    const [v] = await admin.query("SELECT current_setting('server_version') AS version");
    report.postgresVersion = v.version;
    assert.equal(Number(v.version.split('.')[0]), 18, 'This rehearsal targets PostgreSQL 18');
    for (const name of [sourceName, targetName]) {
      await admin.query(`CREATE DATABASE ${identifier(name)} TEMPLATE template0`);
      createdDatabases.push(name);
    }
    source = makeDb(sourceName, legacy);
    await source.initialize();
    assert.equal((await source.runMigrations({ transaction: 'all' })).length, 6);
    checked('legacy_schema_created', { migrations: 6 });
    const users = [];
    for (let i = 0; i < 3; i++) {
      const [u] = await source.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'synthetic-rehearsal',10000) RETURNING id`, [`rehearsal-${i}@example.invalid`]);
      users.push(u.id);
      await source.query(`INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",description) VALUES($1,'EARN',10000,10000,'synthetic initial balance')`, [u.id]);
    }
    const [box] = await source.query(`INSERT INTO gachas(title,price,currency,"totalStock") VALUES('synthetic baseline',100,'GP',1000) RETURNING id`);
    const [item] = await source.query(`INSERT INTO items(name,"estimatedValue","isPremium","conversionGP") VALUES('synthetic prize',1000,false,100) RETURNING id`);
    await source.query(`INSERT INTO gacha_items(gacha_id,item_id,"probabilityPpm") VALUES($1,$2,1000000)`, [box.id, item.id]);
    const prize = { itemId: item.id, name: 'synthetic prize', rarity: 'N', imageUrl: null, estimatedValue: 1000, isPremium: false, conversionGP: 100, probabilityPpm: 1000000 };
    const snapshot = { schemaVersion: 1, mode: 'FIXED_PPM', entries: [prize] };
    const version = probabilityVersion(snapshot);
    const unopened = [];
    for (const userId of users.slice(0, 2)) {
      const orderId = randomUUID();
      const [tx] = await source.query(`INSERT INTO wallet_transactions(user_id,type,amount,"balanceAfter",description) VALUES($1,'USE',-600,9400,'synthetic purchase') RETURNING id`, [userId]);
      await source.query(`UPDATE users SET "coinBalance"=9400 WHERE id=$1`, [userId]);
      await source.query(`INSERT INTO capsule_orders(id,user_id,idempotency_key,gacha_id,title_snapshot,unit_price,quantity,total,currency,status,wallet_transaction_id,balance_after,probability_snapshot,probability_version) VALUES($1,$2,$3,$4,'synthetic baseline',100,6,600,'GP','PAID',$5,9400,$6,$7)`, [orderId,userId,randomUUID(),box.id,tx.id,JSON.stringify(snapshot),version]);
      await source.query('INSERT INTO order_prize_refs(order_id,item_id) VALUES($1,$2)', [orderId,item.id]);
      for (let sequence = 1; sequence <= 6; sequence++) {
        const capsuleId = randomUUID();
        await source.query(`INSERT INTO owned_capsules(id,order_id,sequence,status) VALUES($1,$2,$3,$4)`, [capsuleId,orderId,sequence,sequence === 1 ? 'OPENED' : 'UNOPENED']);
        if (sequence === 1) {
          const [inventory] = await source.query(`INSERT INTO inventory_items(user_id,item_id,status) VALUES($1,$2,'STORED') RETURNING id`, [userId,item.id]);
          await source.query(`INSERT INTO capsule_openings(capsule_id,inventory_item_id,probability_version,prize,ticket) VALUES($1,$2,$3,$4,0)`, [capsuleId,inventory.id,version,JSON.stringify(prize)]);
        } else unopened.push({ userId, capsuleId });
      }
    }
    const fields = await columns(source);
    const baseline = await records(source, fields);
    const oldSequenceNames = (await source.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(r => r.sequencename);
    const baselineSequences = await sequences(source, oldSequenceNames);
    report.baselineTables = baseline;
    checked('synthetic_baseline_recorded', { tables: Object.keys(baseline).length, orders: 2, capsules: 12, opened: 2, unopened: 10 });

    const archive = path.join(temp, 'synthetic.dump');
    const fd = fs.openSync(archive, 'wx', 0o600);
    try {
      execFileSync('docker', ['exec', process.env.REHEARSAL_PG_CONTAINER, 'pg_dump', '--username=gacha_ci', '--format=custom', sourceName], { stdio: ['ignore', fd, 'pipe'], timeout: 60000 });
    } finally { fs.closeSync(fd); }
    const dump = fs.readFileSync(archive);
    assert(dump.length > 0);
    execFileSync('docker', ['exec', '-i', process.env.REHEARSAL_PG_CONTAINER, 'pg_restore', '--username=gacha_ci', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname=' + targetName], { input: dump, timeout: 60000 });
    target = makeDb(targetName, migrations);
    await target.initialize();
    assert.deepEqual(await records(target, fields), baseline);
    assert.deepEqual(await sequences(target, oldSequenceNames), baselineSequences);
    checked('pg_dump_restore_preserves_all_baseline_rows_and_sequences', { archiveBytes: dump.length, archiveSha256: createHash('sha256').update(dump).digest('hex') });

    const applied = await target.runMigrations({ transaction: 'all' });
    assert.equal(applied.length, migrations.length - legacy.length);
    const { migrations: ignored, ...businessFields } = fields;
    const { migrations: ignoredBaseline, ...businessBaseline } = baseline;
    assert.deepEqual(await records(target, businessFields), businessBaseline);
    const businessSequences = oldSequenceNames.filter(n => n !== 'migrations_id_seq');
    assert.deepEqual(await sequences(target, businessSequences), baselineSequences.filter(r => r.sequencename !== 'migrations_id_seq'));
    assert.equal((await target.query('SELECT name FROM migrations')).length, migrations.length);
    checked('upgrade_preserves_every_existing_business_column', { addedMigrations: applied.map(m => m.name), totalMigrations: migrations.length });
    assert.equal((await target.runMigrations({ transaction: 'all' })).length, 0);
    checked('migration_rerun_is_noop');
    await assert.rejects(target.query("UPDATE capsule_orders SET probability_version=repeat('a',64)"), /Order probability is immutable/);
    await assert.rejects(target.query('UPDATE capsule_openings SET ticket=42'), /Capsule opening is immutable/);
    checked('snapshot_and_result_immutability_survives_restore_and_upgrade');
    Object.assign(process.env, { ENABLE_GP_ORDER_PREVIEW: 'true', ENABLE_LEGACY_TRANSACTIONS: 'false' });
    const service = new OrdersService(target);
    for (const c of unopened) {
      const first = await service.open(c.userId, c.capsuleId);
      assert.equal(first.probabilityVersion, version);
      assert.deepEqual(await service.open(c.userId, c.capsuleId), first);
    }
    const [{ n: opened }] = await target.query('SELECT count(*)::integer AS n FROM capsule_openings');
    assert.equal(opened, 12);
    checked('old_unopened_capsules_open_once_after_upgrade', { processed: unopened.length, finalOpenings: opened });

    const { Test } = require('@nestjs/testing');
    const { PassportModule } = require('@nestjs/passport');
    const { ConfigService } = require('@nestjs/config');
    const { JwtService } = require('@nestjs/jwt');
    const { getRepositoryToken } = require('@nestjs/typeorm');
    const { ValidationPipe } = require('@nestjs/common');
    const { User } = compiled('entities');
    const { JwtStrategy } = compiled('modules/auth/strategies/jwt.strategy.js');
    const { OrdersController } = compiled('modules/orders/orders.controller.js');
    const { ResponseTransformInterceptor } = compiled('common/interceptors/response-transform.interceptor.js');
    const { AllExceptionsFilter } = compiled('common/filters/all-exceptions.filter.js');
    const secret = randomUUID() + randomUUID();
    const jwt = new JwtService({ secret });
    const module = await Test.createTestingModule({
      imports: [PassportModule], controllers: [OrdersController],
      providers: [JwtStrategy,
        { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: secret }) },
        { provide: getRepositoryToken(User), useValue: target.getRepository(User) },
        { provide: OrdersService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const buyers = [];
    for (let i = 0; i < 50; i++) {
      const [u] = await target.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES($1,'synthetic-buyer',10000) RETURNING id`, [`buyer-${i}@example.invalid`]);
      buyers.push({ id: u.id, token: jwt.sign({ sub: u.id, av: 0 }, { expiresIn: '10m' }) });
    }
    // Prewarm 50 independent DB connections, rather than a tiny serial pool.
    const runners = Array.from({ length: 50 }, () => target.createQueryRunner());
    try {
      const pids = await Promise.all(runners.map(async r => { await r.connect(); return (await r.query('SELECT pg_backend_pid() AS pid'))[0].pid; }));
      assert.equal(new Set(pids).size, 50);
    } finally { await Promise.all(runners.map(r => r.release())); }
    checked('fifty_independent_postgres_connections_available');
    const call = async (method, route, token, body, key) => {
      const headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      if (key) headers['idempotency-key'] = key;
      const response = await fetch(origin + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await call('GET','/capsules')).status, 401);
    for (let round = 1; round <= 3; round++) {
      const [g] = await target.query(`INSERT INTO gachas(title,price,currency,"totalStock") VALUES('synthetic contention',100,'GP',1) RETURNING id`);
      await target.query(`INSERT INTO gacha_items(gacha_id,item_id,"probabilityPpm") VALUES($1,$2,1000000)`, [g.id,item.id]);
      const odds = await service.odds(g.id);
      const body = { gachaId: g.id, quantity: 1, expectedUnitPrice: 100, expectedProbabilityVersion: odds.version };
      const before = await target.query('SELECT id,"coinBalance"::text AS balance FROM users WHERE id=ANY($1::integer[]) ORDER BY id', [buyers.map(u => u.id)]);
      const keys = buyers.map(() => randomUUID());
      const responses = await Promise.all(buyers.map((u,i) => call('POST','/orders/gp',u.token,body,keys[i])));
      const successes = responses.map((r,i) => ({ ...r,i })).filter(r => r.status === 201);
      const failures = responses.filter(r => r.status !== 201);
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 49);
      for (const f of failures) {
        assert.equal(f.status, 409);
        assert.equal(f.body.message, '남은 수량이 부족합니다');
        assert.deepEqual(f.body.errors, ['ORDER_REJECTED']);
      }
      const winner = successes[0];
      const orders = await target.query('SELECT id,user_id,quantity,total FROM capsule_orders WHERE gacha_id=$1', [g.id]);
      assert.equal(orders.length, 1);
      assert.equal(orders[0].quantity, 1);
      const [{ n: capsules }] = await target.query('SELECT count(*)::integer AS n FROM owned_capsules WHERE order_id=$1', [orders[0].id]);
      assert.equal(capsules, 1);
      const [{ n: debits }] = await target.query('SELECT count(*)::integer AS n FROM capsule_orders o JOIN wallet_transactions w ON w.id=o.wallet_transaction_id WHERE o.gacha_id=$1 AND w.amount=-100', [g.id]);
      assert.equal(debits, 1);
      const after = await target.query('SELECT id,"coinBalance"::text AS balance FROM users WHERE id=ANY($1::integer[]) ORDER BY id', [buyers.map(u => u.id)]);
      for (let i = 0; i < before.length; i++) {
        assert.equal(after[i].id, before[i].id);
        assert.equal(BigInt(after[i].balance), BigInt(before[i].balance) - (after[i].id === orders[0].user_id ? 100n : 0n));
      }
      const retries = await Promise.all(Array.from({ length: 6 }, () => call('POST','/orders/gp',buyers[winner.i].token,body,keys[winner.i])));
      for (const r of retries) { assert.equal(r.status, 201); assert.equal(r.body.data.orderId, orders[0].id); }
      assert.deepEqual(await target.query('SELECT id,"coinBalance"::text AS balance FROM users WHERE id=ANY($1::integer[]) ORDER BY id', [buyers.map(u => u.id)]), after);
      assert.equal((await target.query('SELECT id FROM capsule_orders WHERE gacha_id=$1',[g.id])).length, 1);
      assert.equal((await call('GET','/orders/' + orders[0].id,buyers[(winner.i + 1) % 50].token)).status, 404);
      checked('fifty_http_purchases_one_stock_round_' + round, { requests: 50, success: 1, stockRejected: 49, orders: 1, capsules: 1, purchaseDebits: 1, sameKeyRetries: 6 });
    }
    process.env.NODE_ENV = 'production';
    try { await assert.rejects(service.purchase(buyers[0].id,randomUUID(),{}), e => e.getStatus?.() === 503); }
    finally { process.env.NODE_ENV = 'test'; }
    checked('production_purchase_gate_remains_closed');
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = { name: error.name, message: error.message };
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      if (app) await app.close();
      if (source?.isInitialized) await source.destroy();
      if (target?.isInitialized) await target.destroy();
      if (admin.isInitialized) {
        for (const name of createdDatabases) await admin.query(`DROP DATABASE ${identifier(name)}`);
        await admin.destroy();
      }
      fs.rmSync(temp, { recursive: true, force: true });
      report.cleanup = 'PASS';
    } catch (error) {
      report.cleanup = 'FAIL'; report.status = 'FAIL'; process.exitCode = 1;
      report.cleanupError = error.message;
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(reportDir,'report.json'), JSON.stringify(report,null,2) + '\n', { mode: 0o600 });
    console.log('REHEARSAL_RESULT=' + report.status);
  }
}

if (process.argv.includes('--self-test')) selfTest();
else main().catch(error => { console.error(error.message); process.exitCode = 1; });
