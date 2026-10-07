import { TOPUP_LIMIT_INCREASE_DELAY_DAYS } from '../../common/constants/economy.constant';

/**
 * Rules for the self-set monthly top-up limit (월 충전 한도). Tightening
 * takes effect immediately; loosening (raise or removal) waits out a
 * cooling-off period so a limit can't be lifted on impulse mid-session.
 */

export interface TopupLimitState {
  monthlyTopupLimit: number | null;
  pendingMonthlyTopupLimit: number | null;
  pendingTopupLimitEffectiveAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Applies a pending change whose effective time has passed. */
export function resolveTopupLimit(
  state: TopupLimitState,
  now: Date,
): TopupLimitState {
  const due = state.pendingTopupLimitEffectiveAt;
  if (!due || due.getTime() > now.getTime()) return state;
  return {
    monthlyTopupLimit: state.pendingMonthlyTopupLimit,
    pendingMonthlyTopupLimit: null,
    pendingTopupLimitEffectiveAt: null,
  };
}

export function requestTopupLimitChange(
  state: TopupLimitState,
  requested: number | null,
  now: Date,
): TopupLimitState {
  const current = resolveTopupLimit(state, now).monthlyTopupLimit;
  const tightens =
    requested !== null && (current === null || requested <= current);
  if (tightens) {
    // Also cancels any pending loosening.
    return {
      monthlyTopupLimit: requested,
      pendingMonthlyTopupLimit: null,
      pendingTopupLimitEffectiveAt: null,
    };
  }
  return {
    monthlyTopupLimit: current,
    pendingMonthlyTopupLimit: requested,
    pendingTopupLimitEffectiveAt: new Date(
      now.getTime() + TOPUP_LIMIT_INCREASE_DELAY_DAYS * DAY_MS,
    ),
  };
}
