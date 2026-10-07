import { requestTopupLimitChange, resolveTopupLimit } from './topup-limit';

const now = new Date('2026-10-07T00:00:00Z');
const in7Days = new Date('2026-10-14T00:00:00Z');
const none = {
  monthlyTopupLimit: null,
  pendingMonthlyTopupLimit: null,
  pendingTopupLimitEffectiveAt: null,
};

describe('top-up limit', () => {
  it('applies a first limit immediately', () => {
    expect(requestTopupLimitChange(none, 300000, now)).toEqual({
      ...none,
      monthlyTopupLimit: 300000,
    });
  });

  it('applies a lower limit immediately and cancels a pending raise', () => {
    const state = {
      monthlyTopupLimit: 300000,
      pendingMonthlyTopupLimit: 500000,
      pendingTopupLimitEffectiveAt: in7Days,
    };
    expect(requestTopupLimitChange(state, 100000, now)).toEqual({
      ...none,
      monthlyTopupLimit: 100000,
    });
  });

  it('delays a raise by the cooling-off period', () => {
    const state = { ...none, monthlyTopupLimit: 100000 };
    expect(requestTopupLimitChange(state, 500000, now)).toEqual({
      monthlyTopupLimit: 100000,
      pendingMonthlyTopupLimit: 500000,
      pendingTopupLimitEffectiveAt: in7Days,
    });
  });

  it('delays removing the limit too', () => {
    const state = { ...none, monthlyTopupLimit: 100000 };
    const next = requestTopupLimitChange(state, null, now);
    expect(next.monthlyTopupLimit).toBe(100000);
    expect(next.pendingMonthlyTopupLimit).toBeNull();
    expect(next.pendingTopupLimitEffectiveAt).toEqual(in7Days);
  });

  it('applies a pending change only once it is due', () => {
    const state = {
      monthlyTopupLimit: 100000,
      pendingMonthlyTopupLimit: null,
      pendingTopupLimitEffectiveAt: in7Days,
    };
    expect(resolveTopupLimit(state, now)).toBe(state);
    expect(resolveTopupLimit(state, in7Days)).toEqual(none);
  });
});
