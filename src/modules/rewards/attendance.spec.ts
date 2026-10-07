import { nextStreakDay, rewardForStreakDay } from './attendance';
import {
  addDays,
  startOfKstMonth,
  toKstDateString,
} from '../../common/utils/kst-date';

describe('attendance streak', () => {
  it('starts at day 1 with no history', () => {
    expect(nextStreakDay(null, '2026-10-07')).toBe(1);
  });

  it('continues from yesterday', () => {
    expect(
      nextStreakDay({ checkinDate: '2026-10-06', streakDay: 3 }, '2026-10-07'),
    ).toBe(4);
  });

  it('wraps after day 7', () => {
    expect(
      nextStreakDay({ checkinDate: '2026-10-06', streakDay: 7 }, '2026-10-07'),
    ).toBe(1);
  });

  it('restarts after a missed day', () => {
    expect(
      nextStreakDay({ checkinDate: '2026-10-05', streakDay: 5 }, '2026-10-07'),
    ).toBe(1);
  });

  it('pays the scheduled reward', () => {
    expect(rewardForStreakDay(1)).toBe(100);
    expect(rewardForStreakDay(7)).toBe(500);
  });
});

describe('KST dates', () => {
  it('rolls the day over at KST midnight', () => {
    expect(toKstDateString(new Date('2026-10-06T14:59:59Z'))).toBe(
      '2026-10-06',
    );
    expect(toKstDateString(new Date('2026-10-06T15:00:00Z'))).toBe(
      '2026-10-07',
    );
  });

  it('shifts dates across month boundaries', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('starts the month at KST midnight on the 1st', () => {
    expect(
      startOfKstMonth(new Date('2026-10-31T16:00:00Z')).toISOString(),
    ).toBe('2026-10-31T15:00:00.000Z');
    expect(
      startOfKstMonth(new Date('2026-10-07T03:00:00Z')).toISOString(),
    ).toBe('2026-09-30T15:00:00.000Z');
  });
});
