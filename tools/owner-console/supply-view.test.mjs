import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupplyReader, renderReport, validateReport, formatUnits } from './supply-view.mjs';

function fixture() {
  return { contract: 'SUPPLY_READINESS_V1', readOnly: true, databaseReadOnly: true, productionReady: false, automaticReservation: false, probabilityChanged: false, scope: 'EXISTING_AWARDS_AND_PENDING_DRAW_EXPOSURE', classificationBasis: 'CURRENT_CATALOG_NOT_IMMUTABLE_CONTRACT', asOf: '2026-09-16T08:00:00.000Z', physicalCoverageComplete: true, assessment: 'AWARDED_STOCK_SHORTFALL',
    totals: { orderPendingCapsules: '1000', cardPendingQuantity: '0', invalidSnapshotPools: 0, unresolvedPoolUnits: '0', unclassifiedInventory: '0', unmappedPhysicalInventory: '0', digitalInventoryNotAssessed: '0', digitalPotentialNotAssessed: '0', allocationInconsistentSkus: 0, awardedShortfall: '2', conservativeShortfallSumNotJointOutcome: '1003' },
    itemsNeedingReview: [], skus: [{ skuId: 1, code: 'SYNTHETIC-ONLY', name: '합성 시험 상품', onHand: '3', reserved: '0', available: '3', awardedAwaitingDispatch: '5', creditedShipmentReservations: '0', unreservedAwards: '5', restoreWindowUpperBound: '1', pendingDrawUpperBound: '1000', expectedUnitsIfPendingDrawsComplete: '1.000000', awardedShortfall: '2', conservativeShortfall: '1003', allocationInconsistent: false }] };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function reader(request, config = {}) { const states = []; const control = createSupplyReader({ request, getScope: () => 'test-server:test-owner:test-session', onChange: s => states.push(s), ...config }); return { states, control }; }

test('accepts the current backend response and distinguishes definite gap from expected wins', () => {
  const r = validateReport(fixture()); assert.equal(r.skus[0].awardedShortfall, '2'); assert.equal(r.skus[0].expectedUnitsIfPendingDrawsComplete, '1.000000');
  const html = renderReport(fixture()); assert.match(html, /확정 부족/); assert.match(html, /공급 보장/); assert.match(html, /판매 승인 아님/);
});
test('escapes malicious product names and codes as inert text', () => {
  const r = fixture(); r.skus[0].name = '<img src=x onerror=alert(1)>'; r.skus[0].code = '\" onclick=\"x';
  const html = renderReport(r); assert.ok(!html.includes('<img')); assert.match(html, /&lt;img/); assert.match(html, /&quot; onclick=/);
});
test('does not render unknown sensitive fields', () => {
  const r = fixture(); r.secret = 'SYNTHETIC_SECRET_SENTINEL'; r.skus[0].email = 'not-for-display@example.invalid';
  assert.ok(!JSON.stringify(validateReport(r)).includes('SYNTHETIC_SECRET')); assert.ok(!renderReport(r).includes('@example.invalid'));
});
test('rejects unknown contracts and unsafe readiness assertions', () => {
  for (const patch of [{contract:'SUPPLY_READINESS_V2'},{readOnly:false},{databaseReadOnly:false},{productionReady:true},{automaticReservation:true},{probabilityChanged:true},{assessment:'SELL_NOW'}]) assert.throws(() => validateReport({...fixture(),...patch}));
});
test('rejects negative, fractional, numeric, missing and excessively long quantities', () => {
  for (const value of ['-1','1.5',3,undefined,'9'.repeat(31)]) { const r=fixture(); r.skus[0].onHand=value; assert.throws(() => validateReport(r)); }
});
test('preserves integers above Number.MAX_SAFE_INTEGER without rounding', () => { assert.equal(formatUnits('9007199254740993').replaceAll(',',''), '9007199254740993'); });
test('rejects duplicate SKUs and aggregate mismatches', () => {
  const a=fixture(); a.skus.push({...a.skus[0]}); assert.throws(() => validateReport(a));
  const b=fixture(); b.totals.awardedShortfall='1'; assert.throws(() => validateReport(b));
  const c=fixture(); c.skus[0].available='4'; assert.throws(() => validateReport(c));
});
test('refuses to convert incomplete coverage into a reassuring result', () => {
  const r=fixture(); r.totals.unmappedPhysicalInventory='2'; assert.throws(() => validateReport(r));
  r.physicalCoverageComplete=false; r.assessment='DATA_REVIEW_REQUIRED'; r.itemsNeedingReview=[{itemId:9,reasons:['SKU_LINK_MISSING']}];
  const html=renderReport(r); assert.match(html,/전체 부족분으로 해석하면 안/); assert.match(html,/창고 품목 연결 필요/);
});
test('labels an empty warehouse as unpopulated, not launch ready', () => {
  const r=fixture(); r.skus=[]; r.totals.awardedShortfall='0'; r.totals.conservativeShortfallSumNotJointOutcome='0'; r.assessment='NO_SHORTFALL_IN_ASSESSED_SCOPE';
  assert.match(renderReport(r),/등록된 창고 품목이 없습니다/); assert.equal(validateReport(r).productionReady,false);
});
test('rejects invalid timestamps, unrecognized review reasons, and truncated-looking inputs', () => {
  const a=fixture(); a.asOf='yesterday'; assert.throws(()=>validateReport(a));
  const b=fixture(); b.itemsNeedingReview=[{itemId:1,reasons:['IGNORE']}]; assert.throws(()=>validateReport(b));
  const c=fixture(); c.skus=Array.from({length:2001},()=>({...c.skus[0]})); assert.throws(()=>validateReport(c));
});
test('only requests the fixed GET endpoint with no-store and an abort signal', async () => {
  const {states,control}=reader(async(path,opts)=>{assert.equal(path,'/owner/supply-readiness'); assert.equal(opts.method,'GET'); assert.equal(opts.cache,'no-store'); assert.ok(opts.signal instanceof AbortSignal); return fixture();});
  await control.refresh(); assert.deepEqual(states.map(s=>s.kind),['loading','ready']); control.destroy();
});
test('requires a logged-in scope and never requests data for an absent session', async () => {
  let calls=0; const {states,control}=reader(async()=>{calls++; return fixture();},{getScope:()=>null});
  await control.refresh(); assert.equal(calls,0); assert.equal(states.at(-1).kind,'error'); assert.equal(states.at(-1).report,null); control.destroy();
});
test('clears previous results on refresh failure and redacts raw error content', async () => {
  let success=true; const {states,control}=reader(async()=>{if(success)return fixture(); throw new Error('SYNTHETIC_TOKEN_PASSWORD');});
  await control.refresh(); success=false; await control.refresh(); assert.equal(states.at(-2).report,null); assert.equal(states.at(-1).report,null); assert.ok(!JSON.stringify(states).includes('SYNTHETIC_TOKEN_PASSWORD')); control.destroy();
});
test('reports 401, 403, 404 and 503 without substituting demo results', async () => {
  for (const status of [401,403,404,503]) { const {states,control}=reader(async()=>{throw {status,message:'private details'};}); await control.refresh(); assert.equal(states.at(-1).kind,'error'); assert.equal(states.at(-1).report,null); assert.ok(!states.at(-1).message.includes('private details')); control.destroy(); }
});
test('rejects malformed success payloads without displaying previous data', async () => {
  const {states,control}=reader(async()=>({status:200,data:fixture()})); await control.refresh(); assert.equal(states.at(-1).kind,'error'); assert.equal(states.at(-1).report,null); control.destroy();
});
test('ignores late responses from a previous account or server scope', async () => {
  const d=deferred(); let scope='server-a:owner-a'; const {states,control}=reader(()=>d.promise,{getScope:()=>scope});
  const p=control.refresh(); scope='server-b:owner-b'; d.resolve(fixture()); await p; assert.equal(states.at(-1).kind,'idle'); assert.ok(!states.some(s=>s.kind==='ready')); control.destroy();
});
test('invalidation immediately clears results and aborts an old request', async () => {
  const d=deferred(); let signal; const {states,control}=reader((_p,o)=>{signal=o.signal;return d.promise;});
  const p=control.refresh(); await tick(); control.invalidate(); assert.equal(signal.aborted,true); d.resolve(fixture()); await p; assert.equal(states.at(-1).kind,'idle'); assert.ok(!states.some(s=>s.kind==='ready')); control.destroy();
});
test('a newer refresh supersedes an older request', async () => {
  const d=deferred(); let calls=0; const {states,control}=reader(()=>++calls===1?d.promise:Promise.resolve(fixture()));
  const p=control.refresh(); await tick(); await control.refresh(); d.resolve({bad:true}); await p; assert.equal(states.at(-1).kind,'ready'); assert.equal(states.filter(s=>s.kind==='ready').length,1); control.destroy();
});
test('timeout settles even if a host adapter ignores abort', async () => {
  const {states,control}=reader(()=>new Promise(()=>{}),{timeoutMs:5}); await control.refresh(); assert.equal(states.at(-1).kind,'error'); assert.match(states.at(-1).message,/시간이 초과/); assert.equal(states.at(-1).report,null); control.destroy();
});
test('destroy prevents late callbacks and future requests', async () => {
  const d=deferred(); let calls=0; const {states,control}=reader(()=>{calls++; return d.promise;});
  const p=control.refresh(); await tick(); control.destroy(); const size=states.length; d.resolve(fixture()); await p; await control.refresh(); assert.equal(states.length,size); assert.equal(calls,1);
});
test('immediate logout before dispatch sends no request', async () => {
  let calls=0; const {control}=reader(async()=>{calls++;return fixture();});
  const pending=control.refresh(); control.destroy(); await pending;
  assert.equal(calls,0);
});
test('scope switch before dispatch sends no request under a new identity', async () => {
  let calls=0,scope='server-a:owner-a'; const {states,control}=reader(async()=>{calls++;return fixture();},{getScope:()=>scope});
  const pending=control.refresh(); scope='server-b:owner-b'; await pending;
  assert.equal(calls,0); assert.equal(states.at(-1).report,null); control.destroy();
});
