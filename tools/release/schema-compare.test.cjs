'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { identifierArray, compareRows } = require('./schema-compare.cjs');
const { target, assertStagingTarget } = require('./staging-target.cjs');
const row = { schema_name: 'public', table_name: 'owned_capsules', constraint_name: 'owned_capsules_order_id_fkey',
  type: 'f', columns: ['order_id'], ref_schema: 'public', ref_table: 'capsule_orders', ref_columns: ['id'], delete_action: 'r' };

test('native name array is preserved', () => assert.deepEqual(identifierArray(['order_id']), ['order_id']));
test('PostgreSQL name array text is parsed', () => assert.deepEqual(identifierArray('{order_id}'), ['order_id']));
test('quoted commas, escapes, quoted NULL and empty arrays retain meaning', () => {
  assert.deepEqual(identifierArray('{"a,b","a\\"b","NULL"}'), ['a,b', 'a"b', 'NULL']);
  assert.deepEqual(identifierArray('{}'), []);
});
test('null members and multidimensional identifier arrays fail closed', () => {
  assert.throws(() => identifierArray('{NULL}'));
  assert.throws(() => identifierArray('{{a,b}}'));
  assert.throws(() => identifierArray('not-an-array'));
});
test('identical schema with array representations reconciles', () => {
  assert.equal(compareRows([row], [{ ...row, columns: '{order_id}', ref_columns: '{id}' }]).equal, true);
});
test('catalog row order and object key order do not matter', () => {
  const other = { ...row, constraint_name: 'other' };
  assert.equal(compareRows([row, other], [Object.fromEntries(Object.entries(other).reverse()), row]).equal, true);
});
for (const [field, value] of Object.entries({ schema_name: 'other', table_name: 'other', constraint_name: 'other',
  type: 'u', columns: ['other'], ref_table: 'other', ref_columns: ['other'], delete_action: 'c', update_action: 'c' })) {
  test(`real ${field} mismatch remains a failure`, () => assert.equal(compareRows([row], [{ ...row, [field]: value }]).equal, false));
}
test('composite FK column pairing/order cannot be sorted away', () => {
  const composite = { ...row, columns: ['tenant', 'id'], ref_columns: ['tenant', 'id'] };
  assert.equal(compareRows([composite], [{ ...composite, columns: ['id', 'tenant'] }]).equal, false);
});
test('missing and duplicate constraints fail', () => {
  assert.equal(compareRows([row], []).equal, false);
  assert.equal(compareRows([row], [row, row]).equal, false);
});
test('trigger definition and quoted string whitespace are not erased', () => {
  assert.equal(compareRows([{ definition: "SELECT 'a b'" }], [{ definition: "SELECT 'a  b'" }]).equal, false);
});
test('full source catalog also matches pg name[] wire representation', () => {
  const baseline = require('./schema-baseline.json');
  const expected = baseline.expected.constraints;
  const wire = value => '{' + value.map(x => '"' + x.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
  const actual = expected.map(r => ({ ...r, columns: wire(r.columns), ref_columns: wire(r.ref_columns) }));
  assert.equal(expected.length, 233);
  assert.equal(compareRows(expected, actual).equal, true);
});
const env = { RENDER_SERVICE_ID: target.serviceId, DB_HOST: target.hostname, DB_PORT: '5432',
  DB_DATABASE: target.databaseName, DB_USERNAME: target.username, APP_ENV: 'staging', DB_PASSWORD: 'test-only' };
test('only exact staging identity is admitted', () => assert.equal(assertStagingTarget(env, target.workspaceId), target));
test('old workspace/service/database and other databases fail closed', () => {
  assert.throws(() => assertStagingTarget(env, target.excluded[0]));
  assert.throws(() => assertStagingTarget({ ...env, RENDER_SERVICE_ID: target.excluded[1] }, target.workspaceId));
  assert.throws(() => assertStagingTarget({ ...env, DB_HOST: target.excluded[2] }, target.workspaceId));
  assert.throws(() => assertStagingTarget({ ...env, DB_DATABASE: 'gachigacha_test_db' }, target.workspaceId));
});
