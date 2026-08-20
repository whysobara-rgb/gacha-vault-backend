import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  Draw,
  Gacha,
  GachaItem,
  InventoryItem,
  InventoryStatus,
  User,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { CreateDrawDto } from './dto/create-draw.dto';

@Injectable()
export class DrawsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Executes a single gacha draw as one atomic transaction:
   *   1. Lock the target user row (SELECT ... FOR UPDATE) to serialize
   *      concurrent draws/balance checks for the same user.
   *   2. Validate the gacha exists, is active, and has a non-empty pool.
   *   3. Verify the user has sufficient balance for the gacha price.
   *   4. Pick a result item via weighted random selection over the pool.
   *   5. Deduct the balance, insert the Draw record, insert the resulting
   *      InventoryItem record.
   *   6. Commit. Any failure at any step rolls back all writes.
   */
  async createDraw(userId: number, dto: CreateDrawDto) {
    return this.dataSource.transaction(async (manager) => {
      const userRepo = manager.getRepository(User);
      const gachaRepo = manager.getRepository(Gacha);
      const gachaItemRepo = manager.getRepository(GachaItem);
      const drawRepo = manager.getRepository(Draw);
      const inventoryRepo = manager.getRepository(InventoryItem);

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

      // 3. Balance check.
      if (Number(user.coinBalance) < gacha.price) {
        throw new BusinessException(
          ResponseCode.INSUFFICIENT_BALANCE,
          'Insufficient balance',
          HttpStatus.BAD_REQUEST,
        );
      }

      // 4. Weighted random selection.
      const selected = this.pickWeightedRandom(pool);

      // 5a. Deduct balance.
      user.coinBalance = Number(user.coinBalance) - gacha.price;
      await userRepo.save(user);

      // 5b. Record the draw.
      const draw = await drawRepo.save(
        drawRepo.create({
          userId: user.id,
          gachaId: gacha.id,
          spent: gacha.price,
          currency: gacha.currency,
        }),
      );

      // 5c. Add the resulting item to the user's inventory.
      const inventoryItem = await inventoryRepo.save(
        inventoryRepo.create({
          userId: user.id,
          itemId: selected.item.id,
          drawId: draw.id,
          status: InventoryStatus.STORED,
        }),
      );

      return {
        drawId: draw.id,
        gachaId: gacha.id,
        userId: user.id,
        spent: gacha.price,
        currency: gacha.currency,
        resultItem: {
          inventoryItemId: inventoryItem.id,
          itemId: selected.item.id,
          name: selected.item.name,
          rarity: selected.item.rarity,
        },
        createdAt: draw.createdAt,
      };
    });
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
