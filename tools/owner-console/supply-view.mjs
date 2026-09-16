// Read-only presentation module. Host must supply its authenticated GET adapter.
// This module does not store credentials, change stock, or authorize sales.
const labels = Object.freeze({
  DATA_REVIEW_REQUIRED: '자료 확인 필요',
  AWARDED_STOCK_SHORTFALL: '이미 당첨된 상품의 재고 부족',
  POTENTIAL_STOCK_SHORTFALL: '미개봉·복구에 따른 추가 공급 위험',
  NO_SHORTFALL_IN_ASSESSED_SCOPE: '조회 범위에서 부족분 없음 · 공급 보장 아님',
});
const reasons = Object.freeze({ CLASSIFICATION_REVIEW: '실물·디지털 분류 확인', SKU_LINK_MISSING: '창고 품목 연결 필요', ITEM_MISSING: '구매 기록의 상품 확인 필요' });
const quantities = ['onHand', 'reserved', 'available', 'awardedAwaitingDispatch', 'creditedShipmentReservations', 'unreservedAwards', 'restoreWindowUpperBound', 'pendingDrawUpperBound', 'awardedShortfall', 'conservativeShortfall'];
const totalQuantities = ['orderPendingCapsules', 'cardPendingQuantity', 'unresolvedPoolUnits', 'unclassifiedInventory', 'unmappedPhysicalInventory', 'digitalInventoryNotAssessed', 'digitalPotentialNotAssessed', 'awardedShortfall', 'conservativeShortfallSumNotJointOutcome'];
const invalid = () => { throw new Error('SUPPLY_RESPONSE_INVALID'); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x, max) => { if (typeof x !== 'string' || !x.trim() || x.length > max) invalid(); return x; };
const count = x => { if (typeof x !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(x)) invalid(); return BigInt(x); };
const positive = x => x > 0n ? x : 0n;
const integer = x => { if (!Number.isSafeInteger(x) || x < 0 || x > 10000) invalid(); return x; };
const identity = x => { if (!Number.isSafeInteger(x) || x < 1) invalid(); return x; };
export const escapeHtml = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const formatUnits = x => count(x).toLocaleString('ko-KR');

/** Validate the exact decoded SUPPLY_READINESS_V1 object, not an API envelope. */
export function validateReport(input) {
  if (!object(input) || input.contract !== 'SUPPLY_READINESS_V1' || input.readOnly !== true || input.databaseReadOnly !== true || input.productionReady !== false || input.automaticReservation !== false || input.probabilityChanged !== false) invalid();
  if (input.scope !== 'EXISTING_AWARDS_AND_PENDING_DRAW_EXPOSURE' || input.classificationBasis !== 'CURRENT_CATALOG_NOT_IMMUTABLE_CONTRACT' || !Object.hasOwn(labels, input.assessment) || typeof input.physicalCoverageComplete !== 'boolean') invalid();
  if (typeof input.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.asOf) || !Number.isFinite(Date.parse(input.asOf))) invalid();
  if (!object(input.totals) || !Array.isArray(input.skus) || input.skus.length > 2000 || !Array.isArray(input.itemsNeedingReview) || input.itemsNeedingReview.length > 2000) invalid();
  const totals = {};
  for (const key of totalQuantities) { count(input.totals[key]); totals[key] = input.totals[key]; }
  for (const key of ['invalidSnapshotPools', 'allocationInconsistentSkus']) totals[key] = integer(input.totals[key]);
  const seen = new Set();
  let certain = 0n, upper = 0n, inconsistent = 0;
  const skus = input.skus.map(source => {
    if (!object(source)) invalid();
    const skuId = identity(source.skuId);
    if (seen.has(skuId)) invalid();
    seen.add(skuId);
    const row = { skuId, code: text(source.code, 40), name: text(source.name, 255) };
    for (const key of quantities) { count(source[key]); row[key] = source[key]; }
    if (typeof source.allocationInconsistent !== 'boolean') invalid();
    row.allocationInconsistent = source.allocationInconsistent;
    const v = key => BigInt(row[key]);
    if (v('available') !== positive(v('onHand') - v('reserved')) || v('creditedShipmentReservations') > v('awardedAwaitingDispatch')) invalid();
    if (v('unreservedAwards') !== v('awardedAwaitingDispatch') - v('creditedShipmentReservations')) invalid();
    if (v('awardedShortfall') !== positive(v('unreservedAwards') - v('available')) || v('conservativeShortfall') !== positive(v('unreservedAwards') + v('restoreWindowUpperBound') + v('pendingDrawUpperBound') - v('available'))) invalid();
    if (row.allocationInconsistent) { inconsistent++; if (v('creditedShipmentReservations') !== 0n) invalid(); }
    else if (v('reserved') > v('onHand') || v('creditedShipmentReservations') > v('reserved')) invalid();
    const expected = source.expectedUnitsIfPendingDrawsComplete;
    if (typeof expected !== 'string' || !/^(0|[1-9][0-9]{0,29})\.[0-9]{6}$/.test(expected) || BigInt(expected.replace('.', '')) > v('pendingDrawUpperBound') * 1000000n) invalid();
    row.expectedUnitsIfPendingDrawsComplete = expected;
    certain += v('awardedShortfall'); upper += v('conservativeShortfall');
    return Object.freeze(row);
  });
  if (certain !== BigInt(totals.awardedShortfall) || upper !== BigInt(totals.conservativeShortfallSumNotJointOutcome) || inconsistent > totals.allocationInconsistentSkus) invalid();
  const itemIds = new Set();
  const itemsNeedingReview = input.itemsNeedingReview.map(item => {
    if (!object(item)) invalid();
    const itemId = identity(item.itemId);
    if (itemIds.has(itemId) || !Array.isArray(item.reasons) || !item.reasons.length || item.reasons.length > 3 || item.reasons.some(r => !Object.hasOwn(reasons, r))) invalid();
    itemIds.add(itemId);
    return Object.freeze({ itemId, reasons: Object.freeze([...new Set(item.reasons)]) });
  });
  const incomplete = totals.invalidSnapshotPools > 0 || totals.allocationInconsistentSkus > 0 || ['unresolvedPoolUnits', 'unclassifiedInventory', 'unmappedPhysicalInventory'].some(k => BigInt(totals[k]) > 0n);
  const assessment = incomplete ? 'DATA_REVIEW_REQUIRED' : certain > 0n ? 'AWARDED_STOCK_SHORTFALL' : upper > 0n ? 'POTENTIAL_STOCK_SHORTFALL' : 'NO_SHORTFALL_IN_ASSESSED_SCOPE';
  if (input.physicalCoverageComplete !== !incomplete || input.assessment !== assessment || (itemsNeedingReview.length && !incomplete)) invalid();
  // Whitelist fields, excluding unknown identifiers or future sensitive fields.
  return Object.freeze({ contract: input.contract, asOf: input.asOf, assessment, physicalCoverageComplete: !incomplete, productionReady: false, totals: Object.freeze(totals), skus: Object.freeze(skus), itemsNeedingReview: Object.freeze(itemsNeedingReview) });
}

export function renderReport(input) {
  const r = validateReport(input), n = formatUnits, e = escapeHtml;
  const rows = r.skus.map(s => `<tr><th scope="row">${e(s.name)}<br><small>${e(s.code)}</small></th><td>${n(s.available)}</td><td>${n(s.awardedAwaitingDispatch)}</td><td>${n(s.creditedShipmentReservations)}</td><td><strong>${n(s.awardedShortfall)}</strong></td><td>${n(s.pendingDrawUpperBound)}</td><td>${e(s.expectedUnitsIfPendingDrawsComplete)}</td><td>${n(s.restoreWindowUpperBound)}</td><td>${n(s.conservativeShortfall)}</td><td>${s.allocationInconsistent ? '예약 장부 확인 필요' : '이번 집계상 불일치 없음'}</td></tr>`).join('');
  const review = r.itemsNeedingReview.map(i => `<li>상품 ${i.itemId}: ${i.reasons.map(x => reasons[x]).map(e).join(', ')}</li>`).join('');
  return `<section aria-label="실물 지급 의무 진단"><h2>${labels[r.assessment]}</h2><p>서버 집계 시각: <time datetime="${e(r.asOf)}">${e(r.asOf)}</time>. 조회 직후 재고가 달라질 수 있습니다.</p><p><strong>읽기 전용 · 판매 승인 아님 · 자동 재고 예약 없음</strong></p><p>이 화면을 열거나 새로고침해도 확률·재고·GP·판매 상태는 바뀌지 않습니다.</p><dl><dt>이미 당첨된 상품의 확인된 부족분</dt><dd>${n(r.totals.awardedShortfall)}개${r.physicalCoverageComplete ? '' : ' — 미분류·미연결 항목이 있어 전체 부족분으로 해석하면 안 됩니다.'}</dd><dt>미개봉·환불 대기 캡슐</dt><dd>${n(r.totals.orderPendingCapsules)}개</dd><dt>카드 결제 대기 수량</dt><dd>${n(r.totals.cardPendingQuantity)}개</dd><dt>확률표 오류 / 예약 장부 오류</dt><dd>${r.totals.invalidSnapshotPools}건 / ${r.totals.allocationInconsistentSkus}개 품목</dd><dt>분류 확인 / 창고 미연결 보관 상품</dt><dd>${n(r.totals.unclassifiedInventory)}개 / ${n(r.totals.unmappedPhysicalInventory)}개</dd><dt>공급 미평가 디지털 보관 / 미개봉 노출</dt><dd>${n(r.totals.digitalInventoryNotAssessed)}개 / ${n(r.totals.digitalPotentialNotAssessed)}개</dd></dl><p>기대 수량은 당첨 보장이나 최대 당첨 개수가 아닙니다. 품목별 잠재 상한은 동시에 일어날 수 없는 경우를 포함하므로 합산해 사입 수량으로 사용하지 마세요. 복구기간 수량은 실제 복구 가능 여부의 확정 판정이 아닙니다.</p>${rows ? `<div role="region" aria-label="품목별 공급 위험, 가로 스크롤 가능" tabindex="0" style="overflow-x:auto"><table><caption>현재 창고 품목 기준 · 과거 구매 당시 실물 분류를 보장하지 않음</caption><thead><tr><th scope="col">품목</th><th scope="col">가용 재고</th><th scope="col">미출고 당첨</th><th scope="col">확인된 배송 예약</th><th scope="col">확정 부족</th><th scope="col">미개봉 잠재 상한</th><th scope="col">확률상 기대 수량</th><th scope="col">복구기간 상한</th><th scope="col">품목별 보수적 부족 상한</th><th scope="col">장부</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>등록된 창고 품목이 없습니다. 빈 화면을 공급 준비 완료로 해석하지 마세요.</p>'}${review ? `<h3>연결·분류 확인 대상</h3><ul>${review}</ul>` : ''}<p>반품·교환·재지급, 공급처 확약, 디지털 지급, 향후 신규 판매는 평가 범위 밖입니다. 공급 보장 모델과 실제 출고 검증은 별도로 필요합니다.</p></section>`;
}

const errorText = status => status === 401 ? '로그인이 만료됐습니다. 다시 로그인해주세요.' : status === 403 ? '소유자 권한이 없습니다. 재고 자료를 표시하지 않습니다.' : status === 404 ? '서버에 재고 진단 API가 없습니다. 배포 버전을 확인해주세요.' : status === 503 ? '서버가 진단을 완료하지 못했습니다. 조회 범위와 서버 상태를 확인해주세요.' : '진단 결과를 확인하지 못했습니다. 재고가 충분하다는 뜻이 아닙니다.';
/** getScope(): opaque server/account/session identity, never a token. Invalidate on logout. */
export function createSupplyReader({ request, getScope, onChange, timeoutMs = 10000 }) {
  if ([request, getScope, onChange].some(f => typeof f !== 'function') || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Invalid supply reader configuration');
  let version = 0, disposed = false, active;
  const publish = state => { if (!disposed) onChange(Object.freeze(state)); };
  function invalidate() { version++; active?.abort(); active = undefined; publish({ kind: 'idle', report: null }); }
  async function refresh() {
    if (disposed) return;
    const current = ++version; active?.abort();
    const controller = new AbortController(); active = controller;
    let scope;
    try { scope = getScope(); } catch { scope = null; }
    if (typeof scope !== 'string' || !scope) { publish({ kind: 'error', report: null, message: errorText(401) }); return; }
    publish({ kind: 'loading', report: null });
    let timer, abortHandler;
    try {
      const cancelled = new Promise((_, reject) => {
        abortHandler = () => reject(new Error('CANCELLED'));
        controller.signal.addEventListener('abort', abortHandler, { once: true });
        timer = setTimeout(() => controller.abort(), timeoutMs);
      });
      const input = await Promise.race([Promise.resolve().then(() => request('/owner/supply-readiness', { method: 'GET', cache: 'no-store', signal: controller.signal })), cancelled]);
      if (disposed || current !== version) return;
      if (getScope() !== scope) { invalidate(); return; }
      validateReport(input);
      // Take an owned copy so the host cannot mutate the displayed response later.
      publish({ kind: 'ready', report: JSON.parse(JSON.stringify(input)) });
    } catch (error) {
      if (disposed || current !== version) return;
      let same = false; try { same = getScope() === scope; } catch { /* fail closed */ }
      if (!same) { invalidate(); return; }
      publish({ kind: 'error', report: null, message: controller.signal.aborted ? '조회 시간이 초과됐습니다. 최신 재고를 다시 조회해주세요.' : errorText(error?.status) });
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abortHandler);
      if (active === controller) active = undefined;
    }
  }
  function destroy() { invalidate(); disposed = true; }
  return Object.freeze({ refresh, invalidate, destroy });
}

/** The host owns login, token handling, API-envelope decoding, and logout events. */
export function mountSupplyReadiness(root, options) {
  if (!root || typeof root.addEventListener !== 'function' || typeof root.replaceChildren !== 'function') throw new TypeError('DOM root required');
  const draw = state => {
    root.setAttribute('aria-busy', String(state.kind === 'loading'));
    const body = state.kind === 'ready' ? renderReport(state.report) : `<p role="${state.kind === 'error' ? 'alert' : 'status'}">${escapeHtml(state.message || (state.kind === 'loading' ? '서버의 최신 재고를 확인하고 있습니다.' : '조회 전입니다. 최신 진단을 불러와주세요.'))}</p>`;
    root.innerHTML = `<button type="button" data-supply-refresh ${state.kind === 'loading' ? 'disabled' : ''}>최신 진단 조회</button>${body}`;
  };
  const reader = createSupplyReader({ ...options, onChange: draw });
  const click = event => { if (event.target.closest?.('[data-supply-refresh]') && root.contains(event.target)) void reader.refresh(); };
  root.addEventListener('click', click); draw({ kind: 'idle' });
  return { refresh: reader.refresh, invalidate: reader.invalidate, destroy() { reader.destroy(); root.removeEventListener('click', click); root.replaceChildren(); root.removeAttribute('aria-busy'); } };
}
