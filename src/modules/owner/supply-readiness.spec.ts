import { assessSupply, SupplyItem, SupplySku } from './supply-readiness';
import { ProbabilitySnapshot, probabilityVersion } from '../orders/probability';
const item = (id=1, extra: Partial<SupplyItem> = {}): SupplyItem => ({ id, name: 'synthetic',kind: 'PHYSICAL', skuId: 1, stored: '0', shippingRequested: '0', restoreWindow: '0', ...extra });
const sku = (extra: Partial<SupplySku> = {}): SupplySku => ({ id:1,code:'TEST',name:'synthetic',onHand:3,reserved:0,...extra });
const pool = (entries: [number,number][], quantity='1') => {
  const snapshot: ProbabilitySnapshot = {schemaVersion:1,mode:'FIXED_PPM', entries: entries.map(([itemId,probabilityPpm]) => ({ itemId,probabilityPpm,name:'synthetic',rarity:'N',imageUrl:null,estimatedValue:100,isPremium:false,conversionGP:10 }))};
  return {kind:'ORDER' as const,quantity,snapshot,version:probabilityVersion(snapshot)};
};
describe('read-only supply assessment math', () => {
  it('separates already-awarded shortage from possible draws', () => {
    const r = assessSupply([item(1,{stored:'4'})],[sku()],[],[]);
    expect(r.assessment).toBe('AWARDED_STOCK_SHORTFALL');
    expect(r.skus[0].awardedShortfall).toBe('1');
    expect(r.productionReady).toBe(false);
  });
  it('does not subtract a validated shipment reservation twice', () => {
    const r=assessSupply([item(1,{stored:'1',shippingRequested:'2'})],[sku({reserved:2})],[{skuId:1,quantity:'2',matched:'2',inconsistent:false}],[]);
    expect(r.skus[0]).toMatchObject({available:'1',unreservedAwards:'1',awardedShortfall:'0'});
  });
  it('counts two prizes sharing one SKU only once per pending capsule', () => {
    const r=assessSupply([item(1),item(2)],[sku()],[],[pool([[1,250000],[2,750000]],'5')]);
    expect(r.skus[0]).toMatchObject({pendingDrawUpperBound:'5',expectedUnitsIfPendingDrawsComplete:'5.000000',conservativeShortfall:'2'});
  });
  it('aggregates separate pending pools sharing one physical SKU', () => {
    const r=assessSupply([item(1),item(2,{kind:'DIGITAL',skuId:null})],[sku()],[],[pool([[1,1000],[2,999000]],'1000'),pool([[1,1000000]],'2')]);
    expect(r.skus[0]).toMatchObject({pendingDrawUpperBound:'1002',expectedUnitsIfPendingDrawsComplete:'3.000000'});
    expect(r.totals.digitalPotentialNotAssessed).toBe('1000');
  });
  it('does not treat an expected win count as a stock cap', () => {
    const r=assessSupply([item(),item(2,{kind:'DIGITAL'})],[sku({onHand:1})],[],[pool([[1,1000],[2,999000]],'1000')]);
    expect(r.skus[0]).toMatchObject({expectedUnitsIfPendingDrawsComplete:'1.000000',pendingDrawUpperBound:'1000',conservativeShortfall:'999'});
    expect(r.assessment).toBe('POTENTIAL_STOCK_SHORTFALL');
  });
  it('keeps restore-window exposure distinct from awarded items', () => {
    const r=assessSupply([item(1,{restoreWindow:'5'})],[sku()],[],[]);
    expect(r.skus[0]).toMatchObject({awardedAwaitingDispatch:'0',restoreWindowUpperBound:'5',conservativeShortfall:'2'});
  });
  it('never classifies unknown/missing supply mappings as covered', () => {
    const r=assessSupply([item(1,{kind:'UNSPECIFIED',stored:'1'}),item(2,{skuId:null,stored:'2'})],[sku()],[],[pool([[99,1000000]])]);
    expect(r.assessment).toBe('DATA_REVIEW_REQUIRED');
    expect(r.physicalCoverageComplete).toBe(false);
    expect(r.itemsNeedingReview).toHaveLength(3);
  });
  it('reports corrupt snapshot versions rather than calculating reassuring zeros', () => {
    const p=pool([[1,1000000]]);p.version='a'.repeat(64);
    const r=assessSupply([item()],[sku()],[],[p]);
    expect(r.totals.invalidSnapshotPools).toBe(1);
    expect(r.physicalCoverageComplete).toBe(false);
  });
  it('does not credit inconsistent reserved counters against obligations', () => {
    const r=assessSupply([item(1,{shippingRequested:'2'})],[sku({reserved:2})],[],[]);
    expect(r.skus[0]).toMatchObject({allocationInconsistent:true,creditedShipmentReservations:'0',awardedShortfall:'1'});
  });
  it('keeps counts exact above JavaScript safe-integer range', () => {
    const r=assessSupply([item(1,{stored:'9007199254740993'})],[sku({onHand:0})],[],[]);
    expect(r.skus[0].awardedShortfall).toBe('9007199254740993');
  });
});
