import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  Draw,
  Gacha,
  GachaItem,
  InventoryItem,
  InventoryStatus,
  User,
  WalletTransaction,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { CreateDrawDto } from './dto/create-draw.dto';

@Injectable()
export class DrawsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Executes one or more gacha draws (dto.count, default 1) as a single
   * atomic transaction:
   *   1. Lock the target user row (SELECT ... FOR UPDATE) to serialize
   *      concurrent draws/balance checks for the same user.
   *   2. Validate the gacha exists, is active, and has a non-empty pool.
   *   3. Verify the user has sufficient balance for count * gacha.price.
   *   4. For each draw: pick a result item via weighted random selection,
   *      insert the Draw record, insert the resulting InventoryItem record.
   *   5. Deduct the total balance once, record a single wallet ledger entry
   *      for the whole batch.
   *   6. Commit. Any failure at any step rolls back all writes.
   */
  async createDraw(userId: number, dto: CreateDrawDto) {
    const count = dto.count ?? 1;

    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const gachaRepo = manager.getRepository(Gacha);
      const gachaItemRepo = manager.getRepository(GachaItem);
      const drawRepo = manager.getRepository(Draw);
      const inventoryRepo = manager.getRepository(InventoryItem);
      const walletRepo = manager.getRepository(WalletTransaction);

      // 1. Lock the user row for the duration of the transaction so two
      // concurrent draws for the same user cannot both pass the balance
      // check against a stale balance.
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

      // 2. Validate gacha.
      const gacha = await gachaRepo.findOne({ where: { id: dto.gachaId } });
      if (!gacha || !gacha.active) {
        throw new BusinessException(
          ResponseCode.NOT_FOUND,
          'Gacha not found or inactive',
          HttpStatus.NOT_FOUND,
        );
      }

      const pool = await gachaItemRepo.find({
        where: { gachaId: gacha.id },
        relations: ['item'],
      });
      if (pool.length === 0) {
        throw new BusinessException(
          ResponseCode.CONFLICT,
          'Gacha pool is empty',
          HttpStatus.CONFLICT,
        );
      }

      // 3. Balance check (total cost for the whole batch).
      const totalCost = gacha.price * count;
      if (Number(user.coinBalance) < totalCost) {
        throw new BusinessException(
          ResponseCode.INSUFFICIENT_BALANCE,
          'Insufficient balance',
          HttpStatus.BAD_REQUEST,
        );
      }

      // 4. Perform `count` weighted-random draws.
      const resultItems: Array<{
        drawId: number;
        inventoryItemId: number;
        itemId: number;
        name: string;
        rarity: string;
        estimatedValue: number;
        imageUrl: string | null;
        createdAt: Date;
      }> = [];

      for (let i = 0; i < count; i++) {
        const selected = this.pickWeightedRandom(pool);

        const draw = await drawRepo.save(
          drawRepo.create({
            userId: user.id,
            gachaId: gacha.id,
            spent: gacha.price,
            currency: gacha.currency,
          }),
        );

        const inventoryItem = await inventoryRepo.save(
          inventoryRepo.create({
            userId: user.id,
            itemId: selected.item.id,
            drawId: draw.id,
            status: InventoryStatus.STORED,
          }),
        );

        resultItems.push({
          drawId: draw.id,
          inventoryItemId: inventoryItem.id,
          itemId: selected.item.id,
          name: selected.item.name,
          rarity: selected.item.rarity,
          estimatedValue: selected.item.estimatedValue,
          imageUrl: selected.item.imageUrl,
          createdAt: draw.createdAt,
        });
      }

      // 5a. Deduct balance once for the whole batch.
      user.coinBalance = Number(user.coinBalance) - totalCost;
      await userRepo.save(user);

      // 5b. Record a single wallet ledger entry for the whole batch
      // (powers 포인트내역 screen).
      await walletRepo.save(
        walletRepo.create({
          userId: user.id,
          type: WalletTransactionType.USE,
          amount: -totalCost,
          description:
            count > 1
              ? `${gacha.title} 뽑기 x${count}`
              : `${gacha.title} 뽑기`,
          balanceAfter: user.coinBalance,
        }),
      );

      return {
        gachaId: gacha.id,
        userId: user.id,
        count,
        spent: totalCost,
        currency: gacha.currency,
        balanceAfter: user.coinBalance,
        results: resultItems,
      };
    });
  }

  /** Returns the user's lifetime total draw count (for the profile screen). */
  async getStats(userId: number) {
    const drawRepo = this.dataSource.getRepository(Draw);
    const totalDrawCount = await drawRepo.count({ where: { userId } });
    return { totalDrawCount };
  }

  private pickWeightedRandom(pool: GachaItem[]): GachaItem {
    const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = Math.random() * totalWeight;

    for (const entry of pool) {
      roll -= entry.weight;
      if (roll <= 0) {
        return entry;
      }
    }
    // Fallback for floating point edge cases.
    return pool[pool.length - 1];
  }
}
