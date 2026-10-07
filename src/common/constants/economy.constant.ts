import { ItemRarity } from '../../entities/item-rarity.enum';

/**
 * Economy parameters for 가치가차. These are user-facing rules (they are
 * returned by GET /gachas/:id/odds), so they live in code and change only
 * through a reviewed commit — never per-environment config.
 *
 * Unit convention: 1 GP = 1원 (the 3,000 GP delivery fee is 3,000원).
 */

/** Rarity that the pity (천장) system guarantees. */
export const TOP_TIER_RARITY = ItemRarity.SSR;

/** Display/sort order, rarest first. */
export const RARITY_RANK: Record<ItemRarity, number> = {
  [ItemRarity.SSR]: 0,
  [ItemRarity.SR]: 1,
  [ItemRarity.R]: 2,
  [ItemRarity.N]: 3,
};

/** 10+1: every 10 paid draws in one request grant 1 free bonus draw. */
export const MULTI_DRAW_BONUS = { every: 10, bonus: 1 } as const;

/**
 * Share of an item's estimatedValue credited as GP when the user converts
 * a won item to points (포인트 전환) instead of shipping it.
 */
export const ITEM_EXCHANGE_RATE = 0.8;

/**
 * Pity-adjusted payout ratio (expected item value / price) the seed solves
 * each box's drop weights for. 0.8 means a single draw returns 80% of its
 * price in retail value on average; 10+1 draws return 88%.
 */
export const TARGET_PAYOUT_RATIO = 0.8;

/** 출석체크 rewards (GP) for streak days 1..7; the cycle then restarts. */
export const ATTENDANCE_REWARDS = [100, 100, 150, 150, 200, 200, 500];

/**
 * Raising or removing a self-set monthly top-up limit only takes effect
 * after this cooling-off period. Lowering it is immediate.
 */
export const TOPUP_LIMIT_INCREASE_DELAY_DAYS = 7;

/** GP credited once when an account is created (email or social). */
export const WELCOME_GP = 3000;

/**
 * 첫 충전 보너스: extra GP on a user's first successful payment, as a share
 * of the GP bought, capped.
 */
export const FIRST_TOPUP_BONUS = { rate: 0.2, maxGp: 10000 } as const;

/**
 * GP packages sold through the payment gateway (price in 원). bonusGp is a
 * volume bonus on larger packs, credited separately from the purchased GP.
 */
export const TOPUP_PACKAGES = [
  { id: 'gp5000', price: 5000, gp: 5000, bonusGp: 0 },
  { id: 'gp10000', price: 10000, gp: 10000, bonusGp: 0 },
  { id: 'gp30000', price: 30000, gp: 30000, bonusGp: 0 },
  { id: 'gp50000', price: 50000, gp: 50000, bonusGp: 1000 },
  { id: 'gp100000', price: 100000, gp: 100000, bonusGp: 3000 },
  { id: 'gp300000', price: 300000, gp: 300000, bonusGp: 15000 },
] as const;

export type TopupPackage = (typeof TOPUP_PACKAGES)[number];
