import { ItemRarity } from '../../entities/item-rarity.enum';
import { highestRarity, pickWeighted, planDraws } from './draw-engine';

const entry = (rarity: ItemRarity, weight: number) => ({
  weight,
  item: { rarity },
});
const pool = [
  entry(ItemRarity.SSR, 1),
  entry(ItemRarity.SR, 9),
  entry(ItemRarity.N, 90),
];
/** Always rolls the last slot, i.e. the most common (N) entry here. */
const alwaysN = (max: number) => max - 1;
const alwaysFirst = () => 0;

describe('pickWeighted', () => {
  it('maps every roll to the entry owning that weight range', () => {
    const counts = new Map<ItemRarity, number>();
    for (let roll = 0; roll < 100; roll++) {
      const picked = pickWeighted(pool, () => roll);
      counts.set(picked.item.rarity, (counts.get(picked.item.rarity) ?? 0) + 1);
    }
    expect(counts.get(ItemRarity.SSR)).toBe(1);
    expect(counts.get(ItemRarity.SR)).toBe(9);
    expect(counts.get(ItemRarity.N)).toBe(90);
  });

  it('rejects an empty pool', () => {
    expect(() => pickWeighted([])).toThrow();
  });
});

describe('planDraws', () => {
  it('adds a free bonus draw per 10 paid draws', () => {
    const plan = planDraws({
      pool,
      paidCount: 10,
      pityThreshold: null,
      drawsSinceTopTier: 0,
      rng: alwaysN,
    });
    expect(plan.bonusCount).toBe(1);
    expect(plan.draws).toHaveLength(11);
    expect(plan.draws.filter((d) => d.isBonus)).toHaveLength(1);
    expect(plan.draws[10].isBonus).toBe(true);
  });

  it('forces SSR exactly on the threshold-th dry draw', () => {
    const plan = planDraws({
      pool,
      paidCount: 5,
      pityThreshold: 50,
      drawsSinceTopTier: 47,
      rng: alwaysN,
    });
    const rarities = plan.draws.map((d) => d.entry.item.rarity);
    // Draws 48 and 49 are dry, the 50th is forced, then the count restarts.
    expect(rarities).toEqual([
      ItemRarity.N,
      ItemRarity.N,
      ItemRarity.SSR,
      ItemRarity.N,
      ItemRarity.N,
    ]);
    expect(plan.draws.map((d) => d.isPity)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(plan.drawsSinceTopTier).toBe(2);
  });

  it('resets the counter on a natural SSR without flagging pity', () => {
    const plan = planDraws({
      pool,
      paidCount: 1,
      pityThreshold: 50,
      drawsSinceTopTier: 30,
      rng: alwaysFirst,
    });
    expect(plan.draws[0].entry.item.rarity).toBe(ItemRarity.SSR);
    expect(plan.draws[0].isPity).toBe(false);
    expect(plan.drawsSinceTopTier).toBe(0);
  });

  it('ignores pity for a pool without SSR', () => {
    const plan = planDraws({
      pool: [entry(ItemRarity.N, 1)],
      paidCount: 3,
      pityThreshold: 1,
      drawsSinceTopTier: 0,
      rng: alwaysN,
    });
    expect(plan.draws.every((d) => !d.isPity)).toBe(true);
    expect(plan.drawsSinceTopTier).toBe(3);
  });
});

describe('highestRarity', () => {
  it('returns the rarest rarity', () => {
    expect(highestRarity([ItemRarity.N, ItemRarity.SR, ItemRarity.R])).toBe(
      ItemRarity.SR,
    );
    expect(highestRarity([])).toBeNull();
  });
});
