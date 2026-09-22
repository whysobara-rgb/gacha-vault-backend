'use strict';

// Exact non-production target for operator validation. This module never resets
// data and does not authorize a future cleanup operation.
const target = Object.freeze({
  workspaceId: 'tea-dap5duv40ujc73bkn1o0',
  serviceId: 'srv-dap5vroae00c7396qb9g',
  databaseId: 'dpg-dap5ic0ae00c7395go60-a',
  hostname: 'dpg-dap5ic0ae00c7395go60-a',
  databaseName: 'gachigacha_staging_db',
  username: 'gachigacha_staging_db_user',
  excluded: Object.freeze([
    'tea-d61cfuruibrs73dk946g',
    'srv-dajutmfqj5pc73f6bjq0',
    'dpg-dajupoek1f9s739gsejg-a',
    'gachigacha-test-db',
  ]),
});

function assertStagingTarget(env, workspaceId) {
  if (workspaceId !== target.workspaceId || env.RENDER_SERVICE_ID !== target.serviceId ||
      env.DB_HOST !== target.hostname || env.DB_DATABASE !== target.databaseName ||
      env.DB_USERNAME !== target.username || env.DB_PORT !== '5432' ||
      env.APP_ENV !== 'staging' || !env.DB_PASSWORD) {
    throw new Error('STAGING_TARGET_MISMATCH');
  }
  return target;
}

module.exports = { target, assertStagingTarget };
