import { ItemRarity } from '../../entities/item-rarity.enum';
import {
  bonusDrawsFor,
  exchangeValueOf,
  expectedValue,
  pityProgress,
  pityStats,
  solveTierWeights,
  summarizeEconomy,
} from './gacha-economy';
import { planDraws } from '../draws/draw-engine';

/** Deterministic PRNG (mulberry32) shaped like crypto.randomInt. */
function seededRandomInt(seed: number) {
  let a = seed >>> 0;
  return (maxExclusive: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(u * maxExclusive);
  };
}

const pool = [
  { rarity: ItemRarity.SSR, weight: 5, estimatedValue: 20000 },
  { rarity: ItemRarity.SR, weight: 45, estimatedValue: 3000 },
  { rarity: ItemRarity.R, weight: 250, estimatedValue: 400 },
  { rarity: ItemRarity.N, weight: 700, estimatedValue: 80 },
];

describe('gacha economy', () => {
  it('computes the plain expected value', () => {
    // (5*20000 + 45*3000 + 250*400 + 700*80) / 1000
    expect(expectedValue(pool)).toBeCloseTo(391, 6);
  });

  it('matches the closed form when pity is disabled', () => {
    const stats = pityStats(pool, null);
    expect(stats.effectiveTopTierRate).toBeCloseTo(0.005, 9);
    expect(stats.expectedDrawsToTopTier).toBeCloseTo(200, 6);
    expect(stats.expectedValue).toBeCloseTo(391, 6);
  });

  it('raises the effective SSR rate and value when pity is on', () => {
    const stats = pityStats(pool, 100);
    // E[T] = (1 - 0.995^100) / 0.005
    const cycle = (1 - Math.pow(0.995, 100)) / 0.005;
    expect(stats.expectedDrawsToTopTier).toBeCloseTo(cycle, 9);
    expect(stats.effectiveTopTierRate).toBeGreaterThan(0.005);
    expect(stats.expectedValue).toBeGreaterThan(391);
  });

  it('agrees with a simulation of the real draw engine', () => {
    const rng = seededRandomInt(42);
    const entries = pool.map((e) => ({
      weight: e.weight,
      item: { rarity: e.rarity, value: e.estimatedValue },
    }));
    let counter = 0;
    let draws = 0;
    let ssr = 0;
    let value = 0;
    for (let batch = 0; batch < 20000; batch++) {
      const plan = planDraws({
        pool: entries,
        paidCount: 10,
        pityThreshold: 100,
        drawsSinceTopTier: counter,
        rng,
      });
      counter = plan.drawsSinceTopTier;
      for (const d of plan.draws) {
        draws++;
        value += d.entry.item.value;
        if (d.entry.item.rarity === ItemRarity.SSR) ssr++;
      }
    }
    const stats = pityStats(pool, 100);
    expect(ssr / draws).toBeCloseTo(stats.effectiveTopTierRate, 3);
    expect(value / draws / stats.expectedValue).toBeGreaterThan(0.97);
    expect(value / draws / stats.expectedValue).toBeLessThan(1.03);
  });

  it('solves weights that hit the target payout ratio', () => {
    const values = { SSR: 25000, SR: 12000, R: 300, N: 50 };
    const weights = solveTierWeights({
      values,
      price: 500,
      targetPayoutRatio: 0.8,
      pityThreshold: 200,
    });
    expect(weights.SSR + weights.SR + weights.R + weights.N).toBe(1_000_000);
    expect(weights.SSR).toBeLessThan(weights.SR);
    expect(weights.SR).toBeLessThan(weights.R);
    expect(weights.R).toBeLessThan(weights.N);

    const entries = (Object.keys(weights) as ItemRarity[]).map((rarity) => ({
      rarity,
      weight: weights[rarity],
      estimatedValue: values[rarity],
    }));
    const summary = summarizeEconomy(entries, 500, 200);
    expect(summary.payoutRatio).toBeCloseTo(0.8, 3);
    expect(summary.multiDrawPayoutRatio).toBeCloseTo(0.88, 3);
    expect(summary.exchangeReturnRatio).toBeLessThan(1);
  });

  it('rejects an unreachable target', () => {
    expect(() =>
      solveTierWeights({
        values: { SSR: 100, SR: 50, R: 20, N: 10 },
        price: 1000,
        targetPayoutRatio: 0.8,
        pityThreshold: null,
      }),
    ).toThrow('unreachable');
  });

  it('grants one bonus draw per 10 paid draws', () => {
    expect(bonusDrawsFor(1)).toBe(0);
    expect(bonusDrawsFor(9)).toBe(0);
    expect(bonusDrawsFor(10)).toBe(1);
    expect(bonusDrawsFor(25)).toBe(2);
    expect(bonusDrawsFor(100)).toBe(10);
  });

  it('floors the exchange value at the exchange rate', () => {
    expect(exchangeValueOf(80)).toBe(64);
    expect(exchangeValueOf(99)).toBe(79);
  });

  it('reports pity progress', () => {
    expect(pityProgress(100, 37)).toEqual({
      threshold: 100,
      drawsSinceTopTier: 37,
      remaining: 63,
    });
    expect(pityProgress(null, 5).remaining).toBeNull();
  });
});
