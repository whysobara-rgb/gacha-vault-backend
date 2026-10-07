import { randomInt } from 'crypto';
import { ItemRarity } from '../../entities/item-rarity.enum';
import {
  RARITY_RANK,
  TOP_TIER_RARITY,
} from '../../common/constants/economy.constant';
import { bonusDrawsFor } from '../gacha/gacha-economy';

/**
 * Draw resolution, kept free of I/O so the odds and pity rules can be
 * unit-tested exactly. The service wraps this in the DB transaction.
 */

export interface WeightedPoolEntry {
  weight: number;
  item: { rarity: ItemRarity };
}

/** Uniform integer in [0, maxExclusive). Defaults to a CSPRNG. */
export type RandomIntFn = (maxExclusive: number) => number;

export interface PlannedDraw<T> {
  entry: T;
  isPity: boolean;
  isBonus: boolean;
}

export interface DrawPlan<T> {
  draws: PlannedDraw<T>[];
  bonusCount: number;
  /** Pity counter to persist after these draws. */
  drawsSinceTopTier: number;
}

export function pickWeighted<T extends { weight: number }>(
  entries: T[],
  rng: RandomIntFn = randomInt,
): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (entries.length === 0 || total <= 0) {
    throw new Error('Cannot pick from an empty or zero-weight pool');
  }
  let roll = rng(total);
  for (const entry of entries) {
    if (roll < entry.weight) return entry;
    roll -= entry.weight;
  }
  // Unreachable while rng honours its [0, total) contract.
  return entries[entries.length - 1];
}

/**
 * Resolves `paidCount` draws plus their 10+1 bonus draws.
 *
 * Pity: when the user has gone `pityThreshold - 1` draws without a
 * top-tier item, the next draw is picked among top-tier entries only.
 * Bonus draws count toward (and can trigger) pity like any other draw.
 */
export function planDraws<T extends WeightedPoolEntry>(params: {
  pool: T[];
  paidCount: number;
  pityThreshold: number | null;
  drawsSinceTopTier: number;
  rng?: RandomIntFn;
}): DrawPlan<T> {
  const rng = params.rng ?? randomInt;
  const topTier = params.pool.filter(
    (entry) => entry.item.rarity === TOP_TIER_RARITY && entry.weight > 0,
  );
  const pityActive = !!params.pityThreshold && topTier.length > 0;
  const bonusCount = bonusDrawsFor(params.paidCount);

  let counter = params.drawsSinceTopTier;
  const draws: PlannedDraw<T>[] = [];
  for (let i = 0; i < params.paidCount + bonusCount; i++) {
    const isPity = pityActive && counter + 1 >= params.pityThreshold!;
    const entry = isPity
      ? pickWeighted(topTier, rng)
      : pickWeighted(params.pool, rng);
    counter = entry.item.rarity === TOP_TIER_RARITY ? 0 : counter + 1;
    draws.push({ entry, isPity, isBonus: i >= params.paidCount });
  }
  return { draws, bonusCount, drawsSinceTopTier: counter };
}

export function highestRarity(rarities: ItemRarity[]): ItemRarity | null {
  if (rarities.length === 0) return null;
  return rarities.reduce((best, r) =>
    RARITY_RANK[r] < RARITY_RANK[best] ? r : best,
  );
}
