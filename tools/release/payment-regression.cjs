'use strict';
// Negative control in an ephemeral CI checkout. No Render or external PG access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const baseline = 'ec899c7ad28b1e46056850868f98fba1cdb6ac05';
const sourcePath = 'src/modules/commerce/payments.service.ts';
const source = path.join(root, sourcePath);
const resultDir = path.join(root, 'rehearsal-results');
function runTests(file, pattern) {
  const output = path.join(resultDir, file + '.json');
  const args = ['node_modules/jest/bin/jest.js', '--config', './test/jest-postgres.json',
    '--runInBand', '--runTestsByPath', 'test/payment-reservation.postgres-spec.ts',
    '--json', '--outputFile=' + output];
  if (pattern) args.push('--testNamePattern=' + pattern);
  const result = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  fs.writeFileSync(path.join(resultDir, file + '.log'), (result.stdout || '') + (result.stderr || ''));
  assert(!result.error && !result.signal, 'Regression test runner failed to execute');
  assert(fs.existsSync(output), 'Regression runner did not produce a JSON report');
  return { exit: result.status, json: JSON.parse(fs.readFileSync(output, 'utf8')) };
}
function main() {
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.CI_REHEARSAL, 'true');
  assert.equal(process.env.TEST_POSTGRES, 'true');
  assert.equal(process.env.NODE_ENV, 'test');
  fs.mkdirSync(resultDir, { recursive: true });
  const original = fs.readFileSync(source);
  const report = {
    source: 'GENERATED_SYNTHETIC_DATA', liveRenderDatabaseAccessed: false,
    realPaymentAttempted: false, baselineCommit: baseline, status: 'RUNNING',
    checkedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  };
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', baseline], { cwd: root, stdio: 'pipe', timeout: 30000 });
    const old = execFileSync('git', ['show', baseline + ':' + sourcePath], { cwd: root, maxBuffer: 1024 * 1024 });
    fs.writeFileSync(source, old);
    const before = runTests('payment-before', 'uses the DB clock|rechecks expiry');
    assert.notEqual(before.exit, 0, 'Unfixed code unexpectedly passed the negative control');
    assert.equal(before.json.numRuntimeErrorTestSuites, 0, 'A runtime/compile error is not a valid bug reproduction');
    assert.equal(before.json.numFailedTests, 2);
    const failures = before.json.testResults.flatMap(s => s.assertionResults).filter(t => t.status === 'failed');
    assert.equal(failures.length, 2);
    const clean = text => text.replace(/\u001b\[[0-9;]*m/g, '');
    const skew = failures.find(t => t.title.startsWith('uses the DB clock'));
    const wait = failures.find(t => t.title.startsWith('rechecks expiry'));
    assert(skew && wait, 'Expected named regression failures were not found');
    const skewFailure = clean(skew.failureMessages.join('\n'));
    const waitFailure = clean(wait.failureMessages.join('\n'));
    assert(skewFailure.includes('Expected: 1') && skewFailure.includes('Received: 2'), 'Clock-skew case did not reproduce two orders for one stock');
    assert(waitFailure.includes('Expected: false') && waitFailure.includes('Received: true'), 'Lock-wait case did not reproduce an invalid approval');
    report.before = { failedRegressions: 2, runtimeErrors: 0, oneStockOrdersObserved: 2, expiredApprovalObserved: true };
    fs.writeFileSync(source, original);
    const after = runTests('payment-after');
    assert.equal(after.exit, 0);
    assert.equal(after.json.numFailedTests, 0);
    assert.equal(after.json.numPassedTests, 7);
    assert.equal(after.json.numPendingTests, 0);
    report.after = { passed: 7, failed: 0, pending: 0 };
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = error.message;
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(source, original);
    report.checkedSourceRestored = fs.readFileSync(source).equals(original);
    if (!report.checkedSourceRestored) { report.status = 'FAIL'; process.exitCode = 1; }
    fs.writeFileSync(path.join(resultDir, 'payment-regression.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
