'use strict';
// Only generated data. The encrypted archive and age identity are NEVER uploaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const backup = require('./protected-backup.cjs');
async function main() {
  assert.equal(process.env.CI, 'true'); assert.equal(process.env.TEST_POSTGRES, 'true');
  assert.equal(process.env.NODE_ENV, 'test');
  const container = process.env.REHEARSAL_PG_CONTAINER;
  assert.match(container || '', /^[a-f0-9]{64}$/);
  const { Client } = require('pg');
  require('reflect-metadata'); const { DataSource } = require('typeorm');
  const { dataSourceOptions } = require('../../dist/config/typeorm.config.js');
  const local = { host: '127.0.0.1', port: 5432, user: 'gacha_ci', password: 'local-ci-only', ssl: false };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gacha-backup-'));
  fs.chmodSync(root, 0o700);
  const key = path.join(root, 'identity.txt'), wrong = path.join(root, 'wrong.txt');
  const suffix = randomUUID().replace(/-/g, ''), sourceName = 'gacha_backup_' + suffix, targetName = 'gacha_restore_' + suffix;
  const admin = new Client({ ...local, database: 'postgres' });
  const config = backup.configuration({ CI: 'true', NODE_ENV: 'test', TEST_POSTGRES: 'true',
    DB_HOST: local.host, DB_PORT: '5432', DB_USERNAME: local.user, DB_PASSWORD: local.password, DB_DATABASE: sourceName });
  const source = new Client(config);
  let sourceConnected = false, writer, target, created = [];
  const report = { contract: 'PROTECTED_BACKUP_REHEARSAL_V1', source: 'GENERATED_SYNTHETIC_DATA',
    liveRenderDatabaseAccessed: false, realPaymentAttempted: false, checkedCommit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    status: 'RUNNING', checks: [] };
  const passed = (name, details = {}) => { report.checks.push({name,status:'PASS',...details}); console.log('PASS ' + name); };
  try {
    for (const e of [{}, { DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_USERNAME:'a', DB_DATABASE:'a', DB_PASSWORD:'a' },
      { DB_HOST:'example.com', DB_PORT:'5432', DB_USERNAME:'a', DB_DATABASE:'a', DB_PASSWORD:'a' }]) assert.throws(() => backup.configuration(e));
    const remote = backup.configuration({ DB_HOST:'dpg-synthetic-a.singapore-postgres.render.com',DB_PORT:'5432',DB_USERNAME:'a',DB_DATABASE:'a',DB_PASSWORD:'synthetic' });
    assert.equal(remote.ssl.rejectUnauthorized,true);
    const reject = spawnSync(process.execPath,['tools/release/protected-backup.cjs','--unknown'],{encoding:'utf8',env:{...process.env,DB_PASSWORD:'SYNTHETIC_DO_NOT_LOG'}});
    assert.equal(reject.status,1); assert(!((reject.stdout || '') + (reject.stderr || '')).includes('SYNTHETIC_DO_NOT_LOG'));
    passed('source_config_tls_and_cli_redaction_guards');
    execFileSync('age-keygen',['-o',key],{stdio:'pipe'}); fs.chmodSync(key,0o600);
    execFileSync('age-keygen',['-o',wrong],{stdio:'pipe'}); fs.chmodSync(wrong,0o600);
    const recipient = execFileSync('age-keygen',['-y',key],{encoding:'utf8'}).trim();
    assert.throws(() => backup.validateDestination(root,'not-an-age-public-key'));
    const unsafe = path.join(root,'unsafe'); fs.mkdirSync(unsafe); fs.chmodSync(unsafe,0o755);
    assert.throws(() => backup.validateDestination(unsafe,recipient));
    const symlink = path.join(root,'link'); fs.symlinkSync(root,symlink); assert.throws(() => backup.validateDestination(symlink,recipient));
    assert.throws(() => backup.validateDestination(path.resolve('.'),recipient));
    passed('unsafe_output_and_private_key_input_rejected');
    await admin.connect();
    for (const name of [sourceName,targetName]) { await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created.push(name); }
    const migrationDir = path.resolve('dist/database/migrations');
    const migrations = fs.readdirSync(migrationDir).filter(n => /^\d{13}-.+\.js$/.test(n) && Number(n.slice(0,13)) <= 1789391000000)
      .map(n => Object.values(require(path.join(migrationDir,n))).find(v => typeof v==='function' && v.prototype?.up));
    assert.equal(migrations.length,6);
    writer = new DataSource({ ...dataSourceOptions, type:'postgres',host:local.host,port:local.port,username:local.user,password:local.password,
      database:sourceName,ssl:false,migrations,extra:{max:3},logging:false });
    await writer.initialize(); await writer.runMigrations({transaction:'all'});
    await writer.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES('SYNTHETIC_PRIVATE_MARKER@example.invalid','backup',12345)`);
    const baseline = await writer.query('SELECT to_jsonb(u) AS record FROM users u ORDER BY id');
    await source.connect(); sourceConnected = true;
    const beforePlan = (await writer.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"));
    const plan = await backup.inspectSource(source,config);
    assert.equal(plan.readOnly,true); assert.equal(plan.backupCreated,false);
    assert.deepEqual(await writer.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"), beforePlan);
    passed('source_plan_is_read_only');
    const approval = { directory:root,recipient,expectedTarget:plan.targetFingerprint };
    const existing = fs.readdirSync(root).sort();
    await assert.rejects(backup.createBackup(source,config,{...approval,expectedTarget:'a'.repeat(64)}),{code:'TARGET_MISMATCH'});
    assert.deepEqual(fs.readdirSync(root).sort(),existing);
    passed('wrong_target_creates_no_backup_files');
    const dumpFactory = async args => {
      // Write outside the backup transaction to prove --snapshot binds counts and dump.
      await writer.query(`INSERT INTO users(email,nickname,"coinBalance") VALUES('after-snapshot@example.invalid','later',99)`);
      return backup.command('docker',['exec','-e','PGOPTIONS=-c default_transaction_read_only=on',container,'pg_dump','-U','gacha_ci','-d',sourceName,...args],backup.runtimeEnv());
    };
    const result = await backup.createBackup(source,config,approval,dumpFactory);
    assert.equal(result.manifest.restoreVerified,false);
    assert.equal(result.manifest.productionLaunchApproved,false);
    assert.equal(result.manifest.snapshotConsistentCounts.find(t=>t.schema==='public'&&t.name==='users').count,'1');
    assert.equal(Number((await writer.query('SELECT count(*) AS n FROM users'))[0].n),2);
    const encrypted = fs.readFileSync(result.archivePath);
    assert(encrypted.subarray(0,40).includes(Buffer.from('age-encryption.org/v1')));
    assert(!encrypted.includes(Buffer.from('SYNTHETIC_PRIVATE_MARKER')));
    assert(!encrypted.includes(Buffer.from('AGE-SECRET-KEY')));
    assert.equal(fs.statSync(result.archivePath).mode & 0o077,0);
    assert.equal(fs.statSync(result.manifestPath).mode & 0o077,0);
    assert.deepEqual(await backup.checksum(result.archivePath),{sha256:result.manifest.sha256,bytes:result.manifest.bytes});
    assert(!fs.readdirSync(root).some(n=>n.endsWith('.partial')||n.endsWith('.dump')));
    passed('encrypted_native_export_no_plaintext_file_and_snapshot_count');
    const decrypt = backup.command('age',['--decrypt','--identity',key,result.archivePath],backup.runtimeEnv());
    const restore = backup.command('docker',['exec','-i',container,'pg_restore','-U','gacha_ci','--exit-on-error','--single-transaction','--no-owner','--no-acl','-d',targetName],backup.runtimeEnv());
    restore.stdout.resume();
    await pipeline(decrypt.stdout,restore.stdin);
    for (const p of [decrypt,restore]) assert.equal((await p.done).ok,true);
    target = new Client({...local,database:targetName}); await target.connect();
    assert.deepEqual((await target.query('SELECT to_jsonb(u) AS record FROM users u ORDER BY id')).rows,baseline);
    for (const t of result.manifest.snapshotConsistentCounts) {
      assert.match(t.schema,/^[a-zA-Z0-9_]+$/);assert.match(t.name,/^[a-zA-Z0-9_]+$/);
      assert.equal((await target.query(`SELECT count(*)::text AS n FROM "${t.schema}"."${t.name}"`)).rows[0].n,t.count);
    }
    assert.equal((await target.query('SELECT name FROM migrations')).rows.length,6);
    passed('decrypt_restore_separate_database_values_and_all_table_counts_match',{tables:result.manifest.snapshotConsistentCounts.length});
    const badKey = spawnSync('age',['-d','-i',wrong,result.archivePath],{stdio:['ignore','pipe','pipe'],timeout:5000});
    assert.notEqual(badKey.status,0);
    const damaged = path.join(root,'tampered.age'), damagedBytes = Buffer.from(encrypted); damagedBytes[damagedBytes.length-8] ^= 1;
    fs.writeFileSync(damaged,damagedBytes,{mode:0o600});
    const tamper = spawnSync('age',['-d','-i',key,damaged],{stdio:['ignore','pipe','pipe'],timeout:5000});assert.notEqual(tamper.status,0);
    passed('wrong_key_and_corrupt_ciphertext_rejected');
    const beforeFailure = fs.readdirSync(root).sort();
    await assert.rejects(backup.createBackup(source,config,approval,async()=>backup.command(process.execPath,['-e','console.error("SYNTHETIC_PRIVATE_DIAGNOSTIC");process.exit(1)'],backup.runtimeEnv())),{code:'ENCRYPTED_EXPORT_FAILED'});
    assert.deepEqual(fs.readdirSync(root).sort(),beforeFailure);
    passed('failed_export_removes_partial_archive_and_manifest');
    report.status = 'PASS';
  } catch(e) { report.status='FAIL';report.failure={name:e.name,message:e.message};process.exitCode=1;console.error(e); }
  finally {
    try {
      if (sourceConnected) await source.end(); if(target) await target.end();if(writer?.isInitialized)await writer.destroy();
      for(const name of created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();
      fs.rmSync(root,{recursive:true,force:true});report.cleanup='PASS';
    }catch(e){report.cleanup='FAIL';report.status='FAIL';process.exitCode=1;}
    fs.mkdirSync('backup-rehearsal-results',{recursive:true});
    fs.writeFileSync('backup-rehearsal-results/report.json',JSON.stringify(report,null,2)+'\n');
    console.log('PROTECTED_BACKUP_REHEARSAL='+report.status);
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
