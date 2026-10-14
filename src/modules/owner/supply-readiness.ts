import { normalizeSnapshot, probabilityVersion, ProbabilitySnapshot } from '../orders/probability';

export interface SupplyItem {
  id: number; name: string; kind: string; skuId: number | null;
  stored: string; shippingRequested: string; restoreWindow: string;
}
export interface SupplySku { id: number; code: string; name: string; onHand: number; reserved: number; }
export interface SupplyAllocation { skuId: number; quantity: string; matched: string; inconsistent: boolean; }
export interface SupplyPool { kind: 'ORDER' | 'CARD'; quantity: string; snapshot: ProbabilitySnapshot; version: string; }
const units = (v: string | number) => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(v))) throw new Error('Invalid supply quantity');
  return BigInt(v);
};
const positive = (n: bigint) => n > 0n ? n : 0n;
const expected = (ppmUnits: bigint) => `${ppmUnits / 1000000n}.${String(ppmUnits % 1000000n).padStart(6, '0')}`;

/** Advisory snapshot, not a reservation or permission to sell. No probabilities change. */
export function assessSupply(items: SupplyItem[], skus: SupplySku[], allocations: SupplyAllocation[], pools: SupplyPool[]) {
  const catalog = new Map(items.map(i => [i.id, i]));
  const skuMap = new Map(skus.map(s => [s.id, { ...s, awarded: 0n, restore: 0n, potential: 0n, ppmUnits: 0n }]));
  const alerts = new Map<number, Set<string>>();
  const flag = (id: number, reason: string) => {
    if (!alerts.has(id)) alerts.set(id, new Set());
    alerts.get(id)!.add(reason);
  };
  let unclassified = 0n, unmapped = 0n, digital = 0n;
  for (const i of items) {
    const count = units(i.stored) + units(i.shippingRequested), restore = units(i.restoreWindow);
    if (count + restore === 0n) continue;
    if (i.kind === 'DIGITAL') { digital += count + restore; continue; }
    if (i.kind !== 'PHYSICAL') { unclassified += count + restore; flag(i.id, 'CLASSIFICATION_REVIEW'); continue; }
    const s = i.skuId === null ? undefined : skuMap.get(i.skuId);
    if (!s) { unmapped += count + restore; flag(i.id, 'SKU_LINK_MISSING'); continue; }
    s.awarded += count;
    s.restore += restore;
  }
  let invalidPools = 0, unresolvedUnits = 0n, orderUnits = 0n, cardUnits = 0n;
  let digitalPotential = 0n;
  for (const pool of pools) {
    const n = units(pool.quantity);
    if (pool.kind === 'ORDER') orderUnits += n; else cardUnits += n;
    let entries;
    try {
      entries = normalizeSnapshot(pool.snapshot).entries;
      if (probabilityVersion(pool.snapshot) !== pool.version) throw new Error('Snapshot mismatch');
    } catch { invalidPools++; unresolvedUnits += n; continue; }
    const bySku = new Map<number, bigint>();
    let unresolved = false, hasDigital = false;
    for (const e of entries) {
      const i = catalog.get(e.itemId);
      if (!i) { unresolved = true; flag(e.itemId, 'ITEM_MISSING'); continue; }
      if (i.kind === 'DIGITAL') { hasDigital = true; continue; }
      if (i.kind !== 'PHYSICAL') { unresolved = true; flag(i.id, 'CLASSIFICATION_REVIEW'); continue; }
      if (i.skuId === null || !skuMap.has(i.skuId)) { unresolved = true; flag(i.id, 'SKU_LINK_MISSING'); continue; }
      bySku.set(i.skuId, (bySku.get(i.skuId) || 0n) + BigInt(e.probabilityPpm));
    }
    // Count each pending capsule once per SKU even if several prizes share it.
    for (const [id, ppm] of bySku) {
      const s = skuMap.get(id)!;
      s.potential += n;
      s.ppmUnits += n * ppm;
    }
    if (unresolved) unresolvedUnits += n;
    if (hasDigital) digitalPotential += n;
  }
  const allocationMap = new Map(allocations.map(a => [a.skuId, a]));
  const orphanAllocations = allocations.filter(a => !skuMap.has(a.skuId)).length;
  let awardedShortage = 0n, conservativeShortage = 0n, inconsistentSkus = orphanAllocations;
  const rows = [...skuMap.values()].sort((a, b) => a.id - b.id).map(s => {
    const a = allocationMap.get(s.id);
    const reserved = units(s.reserved), onHand = units(s.onHand);
    const allocationQuantity = a ? units(a.quantity) : 0n;
    const matched = a ? units(a.matched) : 0n;
    const inconsistent = Boolean(a?.inconsistent) || reserved !== allocationQuantity || matched > s.awarded || reserved > onHand;
    if (inconsistent) inconsistentSkus++;
    // Never credit an unverified reservation against an award.
    const credited = inconsistent ? 0n : matched;
    const free = positive(onHand - reserved);
    const outstanding = s.awarded - credited;
    const certainGap = positive(outstanding - free);
    const upperGap = positive(outstanding + s.restore + s.potential - free);
    awardedShortage += certainGap;
    conservativeShortage += upperGap;
    return { skuId: s.id, code: s.code, name: s.name,
      onHand: onHand.toString(), reserved: reserved.toString(), available: free.toString(),
      awardedAwaitingDispatch: s.awarded.toString(), creditedShipmentReservations: credited.toString(),
      unreservedAwards: outstanding.toString(), restoreWindowUpperBound: s.restore.toString(),
      pendingDrawUpperBound: s.potential.toString(), expectedUnitsIfPendingDrawsComplete: expected(s.ppmUnits),
      awardedShortfall: certainGap.toString(), conservativeShortfall: upperGap.toString(),
      allocationInconsistent: inconsistent,
    };
  });
  const incomplete = invalidPools > 0 || unresolvedUnits > 0n || unclassified > 0n || unmapped > 0n || inconsistentSkus > 0;
  return {
    contract: 'SUPPLY_READINESS_V1', readOnly: true,
    productionReady: false, automaticReservation: false, probabilityChanged: false,
    scope: 'EXISTING_AWARDS_AND_PENDING_DRAW_EXPOSURE', classificationBasis: 'CURRENT_CATALOG_NOT_IMMUTABLE_CONTRACT',
    physicalCoverageComplete: !incomplete,
    assessment: incomplete ? 'DATA_REVIEW_REQUIRED' : awardedShortage > 0n ? 'AWARDED_STOCK_SHORTFALL' : conservativeShortage > 0n ? 'POTENTIAL_STOCK_SHORTFALL' : 'NO_SHORTFALL_IN_ASSESSED_SCOPE',
    totals: { orderPendingCapsules: orderUnits.toString(), cardPendingQuantity: cardUnits.toString(),
      invalidSnapshotPools: invalidPools, unresolvedPoolUnits: unresolvedUnits.toString(),
      unclassifiedInventory: unclassified.toString(), unmappedPhysicalInventory: unmapped.toString(),
      digitalInventoryNotAssessed: digital.toString(), digitalPotentialNotAssessed: digitalPotential.toString(),
      allocationInconsistentSkus: inconsistentSkus, awardedShortfall: awardedShortage.toString(),
      conservativeShortfallSumNotJointOutcome: conservativeShortage.toString() },
    itemsNeedingReview: [...alerts].sort((a,b) => a[0]-b[0]).map(([itemId,reasons]) => ({ itemId, reasons: [...reasons].sort() })),
    skus: rows,
    limitations: [
      'READ_ONLY_NOT_A_SUPPLY_GUARANTEE_OR_SALE_AUTHORIZATION',
      'SKU_UPPER_BOUNDS_ARE_MARGINAL_NOT_SIMULTANEOUS_WIN_COUNTS',
      'EXPECTED_UNITS_ARE_NOT_GUARANTEED_WIN_COUNTS',
      'REFUND_PENDING_AND_ACTIVE_CARD_RESERVATIONS_INCLUDED_CONSERVATIVELY',
      'RESTORE_WINDOW_IS_NOT_A_RESTORE_ELIGIBILITY_DECISION',
      'DIGITAL_SUPPLY_RETURNS_EXCHANGES_AND_FUTURE_SALES_NOT_ASSESSED',
      'CURRENT_CATALOG_MAPPING_MAY_DIFFER_FROM_PURCHASE_TIME',
    ],
  };
}
