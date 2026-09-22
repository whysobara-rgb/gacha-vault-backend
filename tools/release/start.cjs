'use strict';

// Production entry point: READ-ONLY preflight, then start the fixed app entry.
// This process never calls migrations --apply, seed scripts or payment APIs.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cli, MigrationGuardError } = require('./migrations.cjs');
const root = path.resolve(__dirname, '../..');
const signalCode = signal => signal === 'SIGINT' ? 130 : 143;

async function main(args = process.argv.slice(2)) {
  if (args.length) throw new MigrationGuardError('INVALID_START_ARGUMENTS');
  require('dotenv').config({ quiet: true, path: path.join(root, '.env') });
  const env = process.env;
  if (!['test', 'development', 'production'].includes(env.NODE_ENV || ''))
    throw new MigrationGuardError('NODE_ENV_REQUIRED');
  if (typeof env.JWT_SECRET !== 'string' || env.JWT_SECRET.trim().length < 32)
    throw new MigrationGuardError('JWT_SECRET_REQUIRED');
  if (env.PORT !== undefined && (!/^\d+$/.test(env.PORT) || Number(env.PORT) < 1 || Number(env.PORT) > 65535))
    throw new MigrationGuardError('INVALID_PORT');

  let child, requestedSignal, timer;
  const signal = name => {
    requestedSignal ||= name;
    if (child) {
      child.kill(name);
      timer ||= setTimeout(() => child.kill('SIGKILL'), 10000).unref();
    }
  };
  const terminate = () => signal('SIGTERM');
  const interrupt = () => signal('SIGINT');
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  try {
    // Always read-only. A backup acknowledgement in the environment cannot
    // convert a start/restart into a migration or fixture execution.
    await cli(['--check-ready']);
    if (requestedSignal) return signalCode(requestedSignal);
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key.startsWith('RELEASE_EXPECTED_') || key.startsWith('RELEASE_BACKUP_')) delete childEnv[key];
    }
    console.log(JSON.stringify({ event: 'START_GATE_PASSED', schema: 'current', productionLaunchApproved: false }));
    return await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [path.join(root, 'dist/main.js')], {
        cwd: root, env: childEnv, stdio: 'inherit', shell: false,
      });
      child.once('error', () => reject(new MigrationGuardError('APP_PROCESS_START_FAILED')));
      child.once('exit', (code, exitSignal) => {
        resolve(requestedSignal ? signalCode(requestedSignal) : exitSignal ? signalCode(exitSignal) : (code ?? 1));
      });
    });
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
  }
}
module.exports = { main };
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(JSON.stringify({ event: 'STARTUP_BLOCKED', code: error instanceof MigrationGuardError ? error.code : 'STARTUP_CHECK_FAILED' }));
  process.exitCode = 1;
});
