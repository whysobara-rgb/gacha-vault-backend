import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  AttendanceCheckin,
  User,
  WalletTransaction,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { ATTENDANCE_REWARDS } from '../../common/constants/economy.constant';
import { addDays, toKstDateString } from '../../common/utils/kst-date';
import { nextStreakDay, rewardForStreakDay } from './attendance';

@Injectable()
export class RewardsService {
  constructor(private readonly dataSource: DataSource) {}

  async getAttendance(userId: number) {
    const today = toKstDateString(new Date());
    const last = await this.lastCheckin(this.dataSource.manager, userId);
    const checkedInToday = last?.checkinDate === today;
    // A streak is alive while its latest check-in is today or yesterday.
    const streakAlive =
      !!last && (checkedInToday || last.checkinDate === addDays(today, -1));
    // The next check-in is tomorrow's if today's is already done.
    const upcoming = nextStreakDay(
      last,
      checkedInToday ? addDays(today, 1) : today,
    );
    return {
      today,
      checkedInToday,
      streakDay: streakAlive ? last.streakDay : 0,
      nextStreakDay: upcoming,
      nextReward: rewardForStreakDay(upcoming),
      schedule: ATTENDANCE_REWARDS.map((reward, i) => ({ day: i + 1, reward })),
    };
  }

  /**
   * Check in for today (KST) and credit the streak reward, atomically. The
   * user row lock serializes concurrent check-ins, and the
   * (user_id, checkinDate) unique constraint backs it up.
   */
  async checkIn(userId: number) {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const user = await userRepo
        .createQueryBuilder('user')
        .setLock('pessimistic_write')
        .where('user.id = :userId', { userId })
        .getOne();
      if (!user) {
        throw new BusinessException(
          ResponseCode.NOT_FOUND,
          'User not found',
          HttpStatus.NOT_FOUND,
        );
      }

      const today = toKstDateString(new Date());
      const last = await this.lastCheckin(manager, userId);
      if (last?.checkinDate === today) {
        throw new BusinessException(
          ResponseCode.ALREADY_CHECKED_IN,
          'Already checked in today',
          HttpStatus.CONFLICT,
        );
      }

      const streakDay = nextStreakDay(last, today);
      const reward = rewardForStreakDay(streakDay);
      await manager.getRepository(AttendanceCheckin).save(
        manager.getRepository(AttendanceCheckin).create({
          userId,
          checkinDate: today,
          streakDay,
          reward,
        }),
      );

      user.coinBalance = Number(user.coinBalance) + reward;
      await userRepo.save(user);

      const walletRepo = manager.getRepository(WalletTransaction);
      await walletRepo.save(
        walletRepo.create({
          userId,
          type: WalletTransactionType.EARN,
          reason: WalletTransactionReason.ATTENDANCE,
          amount: reward,
          description: `출석체크 ${streakDay}일차`,
          balanceAfter: user.coinBalance,
        }),
      );

      return {
        checkinDate: today,
        streakDay,
        reward,
        balanceAfter: user.coinBalance,
      };
    });
  }

  private lastCheckin(manager: EntityManager, userId: number) {
    return manager.getRepository(AttendanceCheckin).findOne({
      where: { userId },
      order: { checkinDate: 'DESC' },
    });
  }
}
