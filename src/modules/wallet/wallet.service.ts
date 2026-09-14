import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { User, WalletTransaction } from '../../entities';
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

  /** GP is reward/conversion only. This route never credits a balance. */
  async topup(_userId: number, _dto: TopupDto): Promise<never> {
    throw new BusinessException(
      ResponseCode.FORBIDDEN,
      'GP는 별도로 충전할 수 없습니다',
      HttpStatus.GONE,
    );
  }
}
