import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  User,
  WalletTransaction,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { ListPointHistoryQueryDto } from './dto/list-point-history.query.dto';
import { TopupDto } from './dto/topup.dto';
import { UpdateTopupLimitDto } from './dto/update-topup-limit.dto';
import {
  requestTopupLimitChange,
  resolveTopupLimit,
  TopupLimitState,
} from './topup-limit';
import { startOfKstMonth } from '../../common/utils/kst-date';

@Injectable()
export class WalletService {
  constructor(private readonly dataSource: DataSource) {}

  async getBalance(userId: number) {
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new BusinessException(
        ResponseCode.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return { balance: Number(user.coinBalance) };
  }

  async getPointHistory(userId: number, query: ListPointHistoryQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const walletRepo = this.dataSource.getRepository(WalletTransaction);
    const where: Record<string, unknown> = { userId };
    if (query.type) {
      where.type = query.type;
    }

    const [rows, totalCount] = await walletRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const items = rows.map((row) => ({
      id: row.id,
      type: row.type,
      reason: row.reason,
      amount: row.amount,
      description: row.description,
      balanceAfter: Number(row.balanceAfter),
      createdAt: row.createdAt,
    }));

    return { items, page, limit, totalCount };
  }

  /**
   * Demo/test top-up: credits the user's balance and records the ledger
   * entry, refusing amounts that would exceed the user's own monthly limit.
   */
  async topup(userId: number, dto: TopupDto) {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const walletRepo = manager.getRepository(WalletTransaction);

      const user = await this.lockUser(manager, userId);
      const now = new Date();
      await this.applyDueLimitChange(manager, user, now);

      if (user.monthlyTopupLimit !== null) {
        const used = await this.sumTopupsThisMonth(manager, user.id, now);
        const remaining = Math.max(0, user.monthlyTopupLimit - used);
        if (dto.amount > remaining) {
          throw new BusinessException(
            ResponseCode.TOPUP_LIMIT_EXCEEDED,
            `Monthly top-up limit exceeded (remaining ${remaining} GP)`,
            HttpStatus.BAD_REQUEST,
            [`remaining:${remaining}`],
          );
        }
      }

      user.coinBalance = Number(user.coinBalance) + dto.amount;
      await userRepo.save(user);

      const tx = await walletRepo.save(
        walletRepo.create({
          userId: user.id,
          type: WalletTransactionType.EARN,
          reason: WalletTransactionReason.TOPUP,
          amount: dto.amount,
          description: 'GP 충전',
          balanceAfter: user.coinBalance,
        }),
      );

      return {
        transactionId: tx.id,
        amount: dto.amount,
        balanceAfter: user.coinBalance,
        createdAt: tx.createdAt,
      };
    });
  }

  async getTopupLimit(userId: number) {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.lockUser(manager, userId);
      const now = new Date();
      await this.applyDueLimitChange(manager, user, now);
      return this.describeLimit(manager, user, now);
    });
  }

  async updateTopupLimit(userId: number, dto: UpdateTopupLimitDto) {
    return this.dataSource.transaction(async (manager) => {
      const user = await this.lockUser(manager, userId);
      const now = new Date();
      Object.assign(
        user,
        requestTopupLimitChange(this.limitState(user), dto.monthlyLimit, now),
      );
      await manager.getRepository(User).save(user);
      return this.describeLimit(manager, user, now);
    });
  }

  private async lockUser(manager: EntityManager, userId: number) {
    const user = await manager
      .getRepository(User)
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
    return user;
  }

  private limitState(user: User): TopupLimitState {
    return {
      monthlyTopupLimit: user.monthlyTopupLimit,
      pendingMonthlyTopupLimit: user.pendingMonthlyTopupLimit,
      pendingTopupLimitEffectiveAt: user.pendingTopupLimitEffectiveAt,
    };
  }

  /** Persists a pending limit change once its cooling-off period is over. */
  private async applyDueLimitChange(
    manager: EntityManager,
    user: User,
    now: Date,
  ) {
    const before = this.limitState(user);
    const after = resolveTopupLimit(before, now);
    if (after !== before) {
      Object.assign(user, after);
      await manager.getRepository(User).save(user);
    }
  }

  private async sumTopupsThisMonth(
    manager: EntityManager,
    userId: number,
    now: Date,
  ): Promise<number> {
    const row = await manager
      .getRepository(WalletTransaction)
      .createQueryBuilder('tx')
      .select('COALESCE(SUM(tx.amount), 0)', 'total')
      .where('tx.userId = :userId', { userId })
      .andWhere('tx.reason = :reason', {
        reason: WalletTransactionReason.TOPUP,
      })
      .andWhere('tx.createdAt >= :since', { since: startOfKstMonth(now) })
      .getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  private async describeLimit(manager: EntityManager, user: User, now: Date) {
    const used = await this.sumTopupsThisMonth(manager, user.id, now);
    const limit = user.monthlyTopupLimit;
    return {
      monthlyLimit: limit,
      usedThisMonth: used,
      remainingThisMonth: limit === null ? null : Math.max(0, limit - used),
      pending: user.pendingTopupLimitEffectiveAt
        ? {
            monthlyLimit: user.pendingMonthlyTopupLimit,
            effectiveAt: user.pendingTopupLimitEffectiveAt,
          }
        : null,
    };
  }
}
