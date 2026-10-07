import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  Draw,
  Gacha,
  GachaItem,
  GachaPityCounter,
  InventoryItem,
  InventoryStatus,
  User,
  WalletTransaction,
  WalletTransactionReason,
  WalletTransactionType,
} from '../../entities';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import { CreateDrawDto } from './dto/create-draw.dto';
import { highestRarity, planDraws } from './draw-engine';
import { exchangeValueOf, pityProgress } from '../gacha/gacha-economy';

@Injectable()
export class DrawsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Executes `dto.count` paid draws (default 1) plus their 10+1 bonus
   * draws as a single atomic transaction:
   *   1. Lock the target user row (SELECT ... FOR UPDATE) to serialize
   *      concurrent draws/balance checks for the same user. This also
   *      serializes updates to the user's pity counters.
   *   2. Validate the gacha exists, is active, and has a non-empty pool.
   *   3. Verify the user has sufficient balance for count * gacha.price.
   *   4. Resolve every draw (CSPRNG weighted pick, pity guarantee, bonus
   *      draws), insert the Draw and InventoryItem rows, persist pity.
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
      const pityRepo = manager.getRepository(GachaPityCounter);
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
        order: { id: 'ASC' },
      });
      if (pool.length === 0) {
        throw new BusinessException(
          ResponseCode.CONFLICT,
          'Gacha pool is empty',
          HttpStatus.CONFLICT,
        );
      }

      // 3. Balance check (total cost for the paid draws; bonus is free).
      const totalCost = gacha.price * count;
      if (Number(user.coinBalance) < totalCost) {
        throw new BusinessException(
          ResponseCode.INSUFFICIENT_BALANCE,
          'Insufficient balance',
          HttpStatus.BAD_REQUEST,
        );
      }

      // 4. Resolve draws against the user's pity progress for this box.
      const pity =
        (await pityRepo.findOne({
          where: { userId: user.id, gachaId: gacha.id },
        })) ??
        pityRepo.create({
          userId: user.id,
          gachaId: gacha.id,
          drawsSinceTopTier: 0,
        });

      const plan = planDraws({
        pool,
        paidCount: count,
        pityThreshold: gacha.pityThreshold,
        drawsSinceTopTier: pity.drawsSinceTopTier,
      });

      const draws = await drawRepo.save(
        plan.draws.map((planned) =>
          drawRepo.create({
            userId: user.id,
            gachaId: gacha.id,
            spent: planned.isBonus ? 0 : gacha.price,
            currency: gacha.currency,
            isPity: planned.isPity,
            isBonus: planned.isBonus,
          }),
        ),
      );
      const inventoryItems = await inventoryRepo.save(
        plan.draws.map((planned, i) =>
          inventoryRepo.create({
            userId: user.id,
            itemId: planned.entry.item.id,
            drawId: draws[i].id,
            status: InventoryStatus.STORED,
          }),
        ),
      );

      pity.drawsSinceTopTier = plan.drawsSinceTopTier;
      await pityRepo.save(pity);

      // 5a. Deduct balance once for the whole batch.
      user.coinBalance = Number(user.coinBalance) - totalCost;
      await userRepo.save(user);

      // 5b. Record a single wallet ledger entry for the whole batch
      // (powers 포인트내역 screen).
      const bonusLabel =
        plan.bonusCount > 0 ? ` (+${plan.bonusCount} 보너스)` : '';
      await walletRepo.save(
        walletRepo.create({
          userId: user.id,
          type: WalletTransactionType.USE,
          reason: WalletTransactionReason.DRAW,
          amount: -totalCost,
          description:
            count > 1
              ? `${gacha.title} 뽑기 x${count}${bonusLabel}`
              : `${gacha.title} 뽑기`,
          balanceAfter: user.coinBalance,
        }),
      );

      const results = plan.draws.map((planned, i) => {
        const item = planned.entry.item;
        return {
          drawId: draws[i].id,
          inventoryItemId: inventoryItems[i].id,
          itemId: item.id,
          name: item.name,
          rarity: item.rarity,
          estimatedValue: item.estimatedValue,
          exchangeValue: exchangeValueOf(item.estimatedValue),
          imageUrl: item.imageUrl,
          isPity: planned.isPity,
          isBonus: planned.isBonus,
          createdAt: draws[i].createdAt,
        };
      });

      return {
        gachaId: gacha.id,
        userId: user.id,
        count,
        bonusCount: plan.bonusCount,
        totalResults: results.length,
        spent: totalCost,
        currency: gacha.currency,
        balanceAfter: user.coinBalance,
        // Lets the client tint the pre-reveal box by the best actual pull.
        highestRarity: highestRarity(results.map((r) => r.rarity)),
        pity: pityProgress(gacha.pityThreshold, plan.drawsSinceTopTier),
        results,
      };
    });
  }

  /** Returns the user's lifetime total draw count (for the profile screen). */
  async getStats(userId: number) {
    const drawRepo = this.dataSource.getRepository(Draw);
    const totalDrawCount = await drawRepo.count({ where: { userId } });
    return { totalDrawCount };
  }
}
