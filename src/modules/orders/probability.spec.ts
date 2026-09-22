import {
  normalizeSnapshot,
  probabilityVersion,
  ProbabilitySnapshot,
  selectPrize,
} from './probability';
const snapshot = (): ProbabilitySnapshot => ({
  schemaVersion: 1,
  mode: 'FIXED_PPM',
  entries: [
    {
      itemId: 1,
      name: 'ordinary',
      rarity: 'N',
      imageUrl: null,
      estimatedValue: 1000,
      isPremium: false,
      conversionGP: 100,
      probabilityPpm: 900000,
    },
    {
      itemId: 2,
      name: 'premium',
      rarity: 'SSR',
      imageUrl: null,
      estimatedValue: 10000,
      isPremium: true,
      conversionGP: 10000,
      probabilityPpm: 100000,
    },
  ],
});
describe('fixed absolute probability snapshots', () => {
  it.each([
    [0, 1],
    [899999, 1],
    [900000, 2],
    [999999, 2],
  ])('maps integer ticket %i to item %i', (ticket, item) => {
    expect(selectPrize(snapshot(), ticket).itemId).toBe(item);
  });
  it('requires exactly one million parts and explicit classification', () => {
    const value = snapshot();
    value.entries[0].probabilityPpm -= 1;
    expect(() => normalizeSnapshot(value)).toThrow();
    const missing = snapshot();
    missing.entries[0].isPremium = null as unknown as boolean;
    expect(() => normalizeSnapshot(missing)).toThrow();
  });
  it('rejects duplicate items and invalid tickets', () => {
    const duplicate = snapshot();
    duplicate.entries[1].itemId = 1;
    expect(() => normalizeSnapshot(duplicate)).toThrow();
    for (const ticket of [-1, 1000000, 1.5, NaN])
      expect(() => selectPrize(snapshot(), ticket)).toThrow();
  });
  it('hashes canonical content, independent of JSON key and entry ordering', () => {
    const reordered = JSON.parse(JSON.stringify(snapshot()));
    reordered.entries.reverse();
    expect(probabilityVersion(reordered)).toBe(probabilityVersion(snapshot()));
    reordered.entries[0].conversionGP += 1;
    expect(probabilityVersion(reordered)).not.toBe(
      probabilityVersion(snapshot()),
    );
  });
});
