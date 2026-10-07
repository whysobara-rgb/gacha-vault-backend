import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import {
  InventoryItem,
  InventoryStatus,
  User,
  WalletTransaction,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { exchangeValueOf } from '../gacha/gacha-economy';
import { ListInventoryQueryDto } from './dto/list-inventory.query.dto';
import { ExchangeInventoryDto } from './dto/exchange-inventory.dto';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(InventoryItem)
    private readonly inventoryRepository: Repository<InventoryItem>,
    private readonly dataSource: DataSource,
  ) {}

  async findAll(userId: number, query: ListInventoryQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Items converted to GP are gone from the vault; they are listed only
    // when explicitly requested with status=EXCHANGED.
    const where: Record<string, unknown> = {
      userId,
      status: query.status ?? Not(InventoryStatus.EXCHANGED),
    };

    // Simple query (no orderBy in the DB query itself) to avoid requiring
    // composite indexes; we page via skip/take and sort in-memory below is
    // not needed here since Postgres default order + createdAt DESC on a
    // single-column filter doesn't require a composite index.
    const [rows, totalCount] = await this.inventoryRepository.findAndCount({
      where,
      relations: ['item'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const items = rows.map((row) => ({
      inventoryItemId: row.id,
      itemId: row.item.id,
      name: row.item.name,
      rarity: row.item.rarity,
      estimatedValue: row.item.estimatedValue,
      exchangeValue: exchangeValueOf(row.item.estimatedValue),
      imageUrl: row.item.imageUrl,
      status: row.status,
      isLocked: row.isLocked,
      acquiredAt: row.createdAt,
    }));

    return { items, page, limit, totalCount };
  }

  /**
   * 포인트 전환: converts stored items to GP at ITEM_EXCHANGE_RATE of their
   * estimated value, atomically:
   *   1. Lock the user row, then the requested inventory rows.
   *   2. Every item must belong to the user, be STORED and unlocked
   *      (anything requested for shipping is excluded).
   *   3. Mark items EXCHANGED, credit the GP, record one ledger entry.
   */
  async exchange(userId: number, dto: ExchangeInventoryDto) {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const inventoryRepo = manager.getRepository(InventoryItem);
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

      const ids = Array.from(new Set(dto.inventoryItemIds));
      const rows = await inventoryRepo
        .createQueryBuilder('inv')
        .innerJoinAndSelect('inv.item', 'item')
        .setLock('pessimistic_write', undefined, ['inv'])
        .where('inv.id IN (:...ids)', { ids })
        .getMany();

      if (rows.length !== ids.length) {
        throw new BusinessException(
          ResponseCode.NOT_FOUND,
          'One or more inventory items not found',
          HttpStatus.NOT_FOUND,
        );
      }
      for (const row of rows) {
        if (row.userId !== userId) {
          throw new BusinessException(
            ResponseCode.FORBIDDEN,
            'Inventory item does not belong to the current user',
            HttpStatus.FORBIDDEN,
          );
        }
        if (row.isLocked || row.status !== InventoryStatus.STORED) {
          throw new BusinessException(
            ResponseCode.CONFLICT,
            `Inventory item ${row.id} is not eligible for exchange`,
            HttpStatus.CONFLICT,
          );
        }
      }

      const totalGp = rows.reduce(
        (sum, row) => sum + exchangeValueOf(row.item.estimatedValue),
        0,
      );

      for (const row of rows) {
        row.status = InventoryStatus.EXCHANGED;
        row.isLocked = true;
      }
      await inventoryRepo.save(rows);

      user.coinBalance = Number(user.coinBalance) + totalGp;
      await userRepo.save(user);

      await walletRepo.save(
        walletRepo.create({
          userId: user.id,
          type: WalletTransactionType.EARN,
          reason: WalletTransactionReason.EXCHANGE,
          amount: totalGp,
          description:
            rows.length > 1
              ? `${rows[0].item.name} 외 ${rows.length - 1}개 포인트 전환`
              : `${rows[0].item.name} 포인트 전환`,
          balanceAfter: user.coinBalance,
        }),
      );

      return {
        exchangedItemIds: rows.map((row) => row.id),
        totalGp,
        balanceAfter: user.coinBalance,
      };
    });
  }
}
