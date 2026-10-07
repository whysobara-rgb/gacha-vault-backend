import { ItemRarity } from '../../entities/item-rarity.enum';
import {
  ITEM_EXCHANGE_RATE,
  MULTI_DRAW_BONUS,
  TOP_TIER_RARITY,
} from '../../common/constants/economy.constant';

/**
 * Pure economy math for a gacha's drop pool: odds, expected value, the
 * effect of the pity (천장) guarantee, and a solver that picks drop weights
 * for a target payout ratio. No I/O, so it is shared by the API (odds
 * disclosure), the seed, and the unit tests.
 */

export interface EconomyEntry {
  rarity: ItemRarity;
  weight: number;
  estimatedValue: number;
}

export interface PityStats {
  /** Expected draws until a top-tier item, with the pity cap applied. */
  expectedDrawsToTopTier: number | null;
  /** Long-run share of draws that are top tier, pity included. */
  effectiveTopTierRate: number;
  /** Long-run expected item value per draw, pity included. */
  expectedValue: number;
}

export interface EconomySummary {
  expectedValue: number;
  pity: PityStats;
  /** Pity-adjusted expected value / price for a single paid draw. */
  payoutRatio: number;
  /** Same, for a 10+1 multi-draw (bonus draws are free). */
  multiDrawPayoutRatio: number;
  /**
   * GP returned per GP spent if every won item is converted to points.
   * Must stay below 1, otherwise draw → exchange is a money printer.
   */
  exchangeReturnRatio: number;
}

export function totalWeight(entries: { weight: number }[]): number {
  return entries.reduce((sum, entry) => sum + entry.weight, 0);
}

export function probabilityOf(entry: EconomyEntry, total: number): number {
  return total > 0 ? entry.weight / total : 0;
}

export function expectedValue(entries: EconomyEntry[]): number {
  const total = totalWeight(entries);
  if (total === 0) return 0;
  return (
    entries.reduce((sum, e) => sum + e.weight * e.estimatedValue, 0) / total
  );
}

/** GP credited when a won item is converted to points. */
export function exchangeValueOf(estimatedValue: number): number {
  return Math.floor(estimatedValue * ITEM_EXCHANGE_RATE);
}

/** Free bonus draws granted for a request of `paidCount` draws (10+1). */
export function bonusDrawsFor(paidCount: number): number {
  return (
    Math.floor(paidCount / MULTI_DRAW_BONUS.every) * MULTI_DRAW_BONUS.bonus
  );
}

/** A user's pity progress as exposed by the API. */
export function pityProgress(
  threshold: number | null,
  drawsSinceTopTier: number,
) {
  return {
    threshold,
    drawsSinceTopTier,
    /** Draws until the guarantee; 1 means the next draw is a sure SSR. */
    remaining:
      threshold === null ? null : Math.max(0, threshold - drawsSinceTopTier),
  };
}

/**
 * Long-run stats with a hard pity: the `threshold`-th consecutive draw
 * without a top-tier item is forced to be top tier.
 *
 * Draws form renewal cycles that each end with exactly one top-tier item.
 * With natural top-tier probability p and cap N, the cycle length T is
 * min(Geometric(p), N), so E[T] = (1 - (1-p)^N) / p. By the renewal-reward
 * theorem the per-draw expected value is
 *   (avgTopValue + (E[T] - 1) * avgOtherValue) / E[T].
 */
export function pityStats(
  entries: EconomyEntry[],
  threshold: number | null,
): PityStats {
  const top = entries.filter((e) => e.rarity === TOP_TIER_RARITY);
  const others = entries.filter((e) => e.rarity !== TOP_TIER_RARITY);
  const total = totalWeight(entries);
  const topWeight = totalWeight(top);
  const p = total > 0 ? topWeight / total : 0;

  if (top.length === 0 || topWeight === 0) {
    return {
      expectedDrawsToTopTier: null,
      effectiveTopTierRate: 0,
      expectedValue: expectedValue(entries),
    };
  }
  if (!threshold || others.length === 0) {
    return {
      expectedDrawsToTopTier: 1 / p,
      effectiveTopTierRate: p,
      expectedValue: expectedValue(entries),
    };
  }

  const cycleLength = p >= 1 ? 1 : (1 - Math.pow(1 - p, threshold)) / p;
  const value =
    (expectedValue(top) + (cycleLength - 1) * expectedValue(others)) /
    cycleLength;
  return {
    expectedDrawsToTopTier: cycleLength,
    effectiveTopTierRate: 1 / cycleLength,
    expectedValue: value,
  };
}

export function summarizeEconomy(
  entries: EconomyEntry[],
  price: number,
  pityThreshold: number | null,
): EconomySummary {
  const pity = pityStats(entries, pityThreshold);
  const payoutRatio = price > 0 ? pity.expectedValue / price : 0;
  const { every, bonus } = MULTI_DRAW_BONUS;
  const multiDrawPayoutRatio = (payoutRatio * (every + bonus)) / every;
  return {
    expectedValue: expectedValue(entries),
    pity,
    payoutRatio,
    multiDrawPayoutRatio,
    exchangeReturnRatio: multiDrawPayoutRatio * ITEM_EXCHANGE_RATE,
  };
}

/** Relative odds of the non-N tiers when solving weights (SSR:SR:R). */
export const DEFAULT_TIER_SHAPE: Record<
  Exclude<ItemRarity, ItemRarity.N>,
  number
> = {
  [ItemRarity.SSR]: 1,
  [ItemRarity.SR]: 6,
  [ItemRarity.R]: 40,
};

export interface SolveWeightsInput {
  values: Record<ItemRarity, number>;
  price: number;
  targetPayoutRatio: number;
  pityThreshold: number | null;
  /** Integer weights sum to this, so 1,000,000 gives 0.0001% resolution. */
  weightScale?: number;
  shape?: typeof DEFAULT_TIER_SHAPE;
}

/**
 * Finds integer drop weights (one item per rarity) whose pity-adjusted
 * payout ratio matches the target. The rare tiers keep the fixed `shape`
 * ratio and are scaled together by k; N absorbs the remainder. Expected
 * value rises monotonically with k, so bisection converges.
 */
export function solveTierWeights(
  input: SolveWeightsInput,
): Record<ItemRarity, number> {
  const scale = input.weightScale ?? 1_000_000;
  const shape = input.shape ?? DEFAULT_TIER_SHAPE;
  const shapeSum = shape.SSR + shape.SR + shape.R;
  const targetValue = input.price * input.targetPayoutRatio;

  const weightsFor = (k: number): Record<ItemRarity, number> => {
    const ssr = Math.max(1, Math.round(k * shape.SSR * scale));
    const sr = Math.max(1, Math.round(k * shape.SR * scale));
    const r = Math.max(1, Math.round(k * shape.R * scale));
    return { SSR: ssr, SR: sr, R: r, N: scale - ssr - sr - r };
  };
  const valueFor = (k: number) => {
    const w = weightsFor(k);
    const entries = (Object.keys(w) as ItemRarity[]).map((rarity) => ({
      rarity,
      weight: w[rarity],
      estimatedValue: input.values[rarity],
    }));
    return pityStats(entries, input.pityThreshold).expectedValue;
  };

  let lo = 0;
  let hi = 1 / shapeSum;
  if (valueFor(lo) > targetValue || valueFor(hi) < targetValue) {
    throw new Error(
      `Target payout ${input.targetPayoutRatio} is unreachable for price ${input.price}`,
    );
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (valueFor(mid) < targetValue) lo = mid;
    else hi = mid;
  }
  return weightsFor((lo + hi) / 2);
}
