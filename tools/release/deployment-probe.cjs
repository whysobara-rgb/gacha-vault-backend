'use strict';
// Read-only post-deployment probe. Never sends an auth token, payment or DB write.
const MAX_BYTES = 32768;
class ProbeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ProbeError(code); };
const validCommit = s => typeof s === 'string' && s.length === 40 && /^[a-f0-9]{40}$/.test(s);
function configuration(env) {
  if (!validCommit(env.PROBE_EXPECTED_COMMIT)) fail('EXPECTED_COMMIT_REQUIRED');
  let url;
  try { url = new URL(env.PROBE_ORIGIN); } catch { fail('ORIGIN_REQUIRED'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('ORIGIN_ONLY_REQUIRED');
  const local = env.NODE_ENV === 'test' && env.ALLOW_LOCAL_PROBE === 'true' &&
    ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) fail('HTTPS_REQUIRED');
  return { origin: url.origin, expected: env.PROBE_EXPECTED_COMMIT };
}
function assess(status, body, expected) {
  if (!validCommit(expected)) fail('EXPECTED_COMMIT_REQUIRED');
  if (status !== 200) fail('READINESS_HTTP_FAILED');
  if (!body || body.statusCode !== 10000 || body.message !== 'success' || !body.data) fail('INVALID_API_ENVELOPE');
  const data = body.data;
  if (data.service !== 'gacha-vault-api' || data.status !== 'ready' ||
      data.database !== 'connected' || data.schema !== 'current') fail('DATABASE_NOT_READY');
  const r = data.release;
  if (!r || r.contract !== 'RELEASE_IDENTITY_V1' || r.consistent !== true ||
      !['render', 'configured'].includes(r.source) || !validCommit(r.commit)) fail('REVISION_UNVERIFIED');
  if (r.commit !== expected) fail('REVISION_MISMATCH');
  return {
    status: 'PASS', deploymentVerified: true, reportedCommit: r.commit,
    revisionEvidence: 'SERVER_REPORTED_COMPARE_WITH_PROVIDER_DEPLOY_RECORD',
    businessLaunchApproved: false,
  };
}
async function readJson(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) fail('INVALID_CONTENT_TYPE');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) fail('RESPONSE_TOO_LARGE');
  if (!response.body) fail('EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > MAX_BYTES) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_JSON'); }
}
async function probe(env = process.env, request = globalThis.fetch) {
  const report = { contract: 'DEPLOYMENT_PROBE_V1', status: 'BLOCKED',
    deploymentVerified: false, businessLaunchApproved: false,
    observedAt: new Date().toISOString() };
  try {
    const { origin, expected } = configuration(env);
    const response = await request(origin + '/health/ready', {
      method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000),
    });
    if (response.status !== 200) fail('READINESS_HTTP_FAILED');
    return { ...report, ...assess(response.status, await readJson(response), expected) };
  } catch (error) {
    return { ...report, code: error instanceof ProbeError ? error.code : 'TRANSPORT_FAILED' };
  }
}
module.exports = { configuration, assess, probe };
if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error(JSON.stringify({ status: 'BLOCKED', code: 'INVALID_ARGUMENTS' }));
    process.exitCode = 1;
  } else probe().then(report => {
    console.log(JSON.stringify(report));
    if (!report.deploymentVerified) process.exitCode = 1;
  });
}
