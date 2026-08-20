import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User, WalletTransaction, WalletTransactionType } from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { ListPointHistoryQueryDto } from './dto/list-point-history.query.dto';
import { TopupDto } from './dto/topup.dto';

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
      amount: row.amount,
      description: row.description,
      balanceAfter: Number(row.balanceAfter),
      createdAt: row.createdAt,
    }));

    return { items, page, limit, totalCount };
  }

  /** Demo/test top-up: credits the user's balance and records the ledger entry. */
  async topup(userId: number, dto: TopupDto) {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const walletRepo = manager.getRepository(WalletTransaction);

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

      user.coinBalance = Number(user.coinBalance) + dto.amount;
      await userRepo.save(user);

      const tx = await walletRepo.save(
        walletRepo.create({
          userId: user.id,
          type: WalletTransactionType.EARN,
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
}
