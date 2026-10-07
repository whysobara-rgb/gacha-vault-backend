import { ATTENDANCE_REWARDS } from '../../common/constants/economy.constant';
import { addDays } from '../../common/utils/kst-date';

/**
 * 7-day 출석체크 cycle: consecutive KST days advance the streak (1..7,
 * then back to 1); missing a day restarts it at 1.
 */
export function nextStreakDay(
  lastCheckin: { checkinDate: string; streakDay: number } | null,
  today: string,
): number {
  if (!lastCheckin || lastCheckin.checkinDate !== addDays(today, -1)) {
    return 1;
  }
  return (lastCheckin.streakDay % ATTENDANCE_REWARDS.length) + 1;
}

export function rewardForStreakDay(streakDay: number): number {
  return ATTENDANCE_REWARDS[streakDay - 1];
}
