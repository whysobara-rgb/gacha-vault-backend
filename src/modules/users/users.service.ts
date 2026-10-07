import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import {
  ShippingRequest,
  ShippingRequestStatus,
  User,
  WalletTransaction,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async getProfile(userId: number) {
    return toProfile(await this.findActive(this.userRepository, userId));
  }

  async updateProfile(userId: number, dto: UpdateProfileDto) {
    const user = await this.findActive(this.userRepository, userId);
    if (dto.nickname !== undefined) user.nickname = dto.nickname.trim();
    if (dto.agreeMarketing !== undefined) {
      user.marketingAgreedAt = dto.agreeMarketing
        ? (user.marketingAgreedAt ?? new Date())
        : null;
    }
    return toProfile(await this.userRepository.save(user));
  }

  /**
   * 회원 탈퇴. Personal data is wiped and sign-in disabled, but the row
   * stays because payment/order records must be retained (전자상거래법).
   * Refused while a shipment is still being prepared or delivered, since
   * the recipient details are needed to finish it.
   */
  async deleteAccount(userId: number) {
    return this.dataSource.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const user = await users
        .createQueryBuilder('user')
        .setLock('pessimistic_write')
        .where('user.id = :userId AND user.deletedAt IS NULL', { userId })
        .getOne();
      if (!user) throw notFound();

      const activeShipments = await manager
        .getRepository(ShippingRequest)
        .count({
          where: {
            userId,
            status: In([
              ShippingRequestStatus.REQUESTED,
              ShippingRequestStatus.SHIPPING,
            ]),
          },
        });
      if (activeShipments > 0) {
        throw new BusinessException(
          ResponseCode.ACTIVE_SHIPMENTS,
          'Account has shipments in progress',
          HttpStatus.CONFLICT,
          [`activeShipments:${activeShipments}`],
        );
      }

      const forfeited = Number(user.coinBalance);
      if (forfeited > 0) {
        await manager.getRepository(WalletTransaction).save(
          manager.getRepository(WalletTransaction).create({
            userId,
            type: WalletTransactionType.EXPIRE,
            reason: WalletTransactionReason.ADJUSTMENT,
            amount: -forfeited,
            description: '회원 탈퇴로 GP 소멸',
            balanceAfter: 0,
          }),
        );
      }

      const now = new Date();
      Object.assign(user, {
        email: `deleted_${user.id}_${now.getTime()}@deleted.gachivault.invalid`,
        nickname: '탈퇴회원',
        password: null,
        providerId: null,
        coinBalance: 0,
        marketingAgreedAt: null,
        monthlyTopupLimit: null,
        pendingMonthlyTopupLimit: null,
        pendingTopupLimitEffectiveAt: null,
        deletedAt: now,
      });
      await users.save(user);
      return { deleted: true, forfeitedGp: forfeited };
    });
  }

  private async findActive(repo: Repository<User>, userId: number) {
    const user = await repo.findOne({
      where: { id: userId, deletedAt: IsNull() },
    });
    if (!user) throw notFound();
    return user;
  }
}

function notFound() {
  return new BusinessException(
    ResponseCode.NOT_FOUND,
    'User not found',
    HttpStatus.NOT_FOUND,
  );
}

function toProfile(user: User) {
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    coinBalance: Number(user.coinBalance),
    provider: user.provider,
    role: user.role,
    marketingAgreed: user.marketingAgreedAt !== null,
    createdAt: user.createdAt,
  };
}
