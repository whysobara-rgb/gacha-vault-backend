import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Gacha, GachaItem, GachaPityCounter } from '../../entities';
import { ListGachasQueryDto } from './dto/list-gachas.query.dto';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import {
  ITEM_EXCHANGE_RATE,
  MULTI_DRAW_BONUS,
  RARITY_RANK,
  TOP_TIER_RARITY,
} from '../../common/constants/economy.constant';
import {
  exchangeValueOf,
  pityProgress,
  probabilityOf,
  summarizeEconomy,
  totalWeight,
} from './gacha-economy';

/** Real round stock: soldStock only counts boxes that were actually opened. */
function stockOf(gacha: Gacha) {
  return {
    totalStock: gacha.totalStock,
    soldStock: gacha.soldCount,
    soldOut: gacha.soldCount >= gacha.totalStock,
  };
}

/** Ratio (0..1) → percent rounded to 4 decimals, e.g. 0.0068667 → 0.6867. */
function toPercent(ratio: number): number {
  return Math.round(ratio * 1_000_000) / 10_000;
}

@Injectable()
export class GachaService {
  constructor(
    @InjectRepository(Gacha)
    private readonly gachaRepository: Repository<Gacha>,
    @InjectRepository(GachaItem)
    private readonly gachaItemRepository: Repository<GachaItem>,
    @InjectRepository(GachaPityCounter)
    private readonly pityRepository: Repository<GachaPityCounter>,
  ) {}

  async findAll(query: ListGachasQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [items, totalCount] = await this.gachaRepository.findAndCount({
      where: { active: true },
      order: { id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const topPrizes = await this.topPrizesFor(items.map((gacha) => gacha.id));

    return {
      items: items.map((gacha) => ({
        id: gacha.id,
        title: gacha.title,
        description: gacha.description,
        price: gacha.price,
        currency: gacha.currency,
        active: gacha.active,
        tagline: gacha.tagline,
        iconName: gacha.iconName,
        badgeLabel: gacha.badgeLabel,
        accentColorHex: gacha.accentColorHex,
        imageUrl: gacha.imageUrl,
        pityThreshold: gacha.pityThreshold,
        ...stockOf(gacha),
        topPrize: topPrizes.get(gacha.id) ?? null,
      })),
      page,
      limit,
      totalCount,
    };
  }

  /**
   * Gacha detail: real sold stock (boxes actually opened this round) plus
   * the actual drop-pool lineup (item name/rarity/
   * image/weight), so the Flutter "LUCKY LINEUP" section always reflects
   * exactly what can be won from *this* specific box — never a hardcoded
   * generic list.
   */
  async findOne(id: number) {
    const gacha = await this.getGachaOrThrow(id);

    const pool = await this.loadPool(gacha.id);
    const poolWeight = totalWeight(pool);

    // Rarity rank drives lineup display order: rarest first, like TIF's
    // "LUCKY LINEUP" hero-first layout.
    const lineup = pool.map((entry) => ({
      itemId: entry.item.id,
      name: entry.item.name,
      rarity: entry.item.rarity,
      estimatedValue: entry.item.estimatedValue,
      exchangeValue: exchangeValueOf(entry.item.estimatedValue),
      imageUrl: entry.item.imageUrl,
      weight: entry.weight,
      probabilityPercent: toPercent(
        probabilityOf(this.economyEntry(entry), poolWeight),
      ),
    }));

    return {
      id: gacha.id,
      title: gacha.title,
      description: gacha.description,
      price: gacha.price,
      currency: gacha.currency,
      active: gacha.active,
      tagline: gacha.tagline,
      iconName: gacha.iconName,
      badgeLabel: gacha.badgeLabel,
      accentColorHex: gacha.accentColorHex,
      imageUrl: gacha.imageUrl,
      ...stockOf(gacha),
      pityThreshold: gacha.pityThreshold,
      lineup,
    };
  }

  /**
   * 확률 공시: exact per-item and per-rarity odds plus every rule that
   * changes them (pity, 10+1 bonus) and the resulting expected value, so
   * a user can see precisely what a draw is worth before paying.
   */
  async getOdds(id: number) {
    const gacha = await this.getGachaOrThrow(id);
    const pool = await this.loadPool(gacha.id);
    const entries = pool.map((entry) => this.economyEntry(entry));
    const poolWeight = totalWeight(entries);
    const economy = summarizeEconomy(entries, gacha.price, gacha.pityThreshold);

    const rarities = Object.keys(RARITY_RANK)
      .map((rarity) => {
        const inTier = entries.filter((e) => e.rarity === rarity);
        return {
          rarity,
          probabilityPercent: toPercent(
            totalWeight(inTier) / (poolWeight || 1),
          ),
          itemCount: inTier.length,
        };
      })
      .filter((tier) => tier.itemCount > 0);

    const topTierBaseRate =
      totalWeight(entries.filter((e) => e.rarity === TOP_TIER_RARITY)) /
      (poolWeight || 1);
    const hasPity =
      gacha.pityThreshold !== null && economy.pity.effectiveTopTierRate > 0;

    return {
      gachaId: gacha.id,
      title: gacha.title,
      price: gacha.price,
      currency: gacha.currency,
      items: pool.map((entry, i) => ({
        itemId: entry.item.id,
        name: entry.item.name,
        rarity: entry.item.rarity,
        estimatedValue: entry.item.estimatedValue,
        exchangeValue: exchangeValueOf(entry.item.estimatedValue),
        imageUrl: entry.item.imageUrl,
        weight: entry.weight,
        probabilityPercent: toPercent(probabilityOf(entries[i], poolWeight)),
      })),
      rarities,
      pity: hasPity
        ? {
            threshold: gacha.pityThreshold,
            rarity: TOP_TIER_RARITY,
            baseRatePercent: toPercent(topTierBaseRate),
            effectiveRatePercent: toPercent(economy.pity.effectiveTopTierRate),
            expectedDrawsToHit:
              Math.round((economy.pity.expectedDrawsToTopTier ?? 0) * 10) / 10,
          }
        : null,
      multiDrawBonus: { ...MULTI_DRAW_BONUS },
      exchangeRatePercent: toPercent(ITEM_EXCHANGE_RATE),
      expectedValue: {
        perDraw: Math.round(economy.expectedValue),
        perDrawWithPity: Math.round(economy.pity.expectedValue),
      },
      payoutRatioPercent: {
        singleDraw: Math.round(economy.payoutRatio * 1000) / 10,
        multiDraw: Math.round(economy.multiDrawPayoutRatio * 1000) / 10,
      },
    };
  }

  /** The caller's pity (천장) progress on one box. */
  async getPity(userId: number, id: number) {
    const gacha = await this.getGachaOrThrow(id);
    const counter = await this.pityRepository.findOne({
      where: { userId, gachaId: gacha.id },
    });
    return {
      gachaId: gacha.id,
      ...pityProgress(gacha.pityThreshold, counter?.drawsSinceTopTier ?? 0),
    };
  }

  private async getGachaOrThrow(id: number) {
    const gacha = await this.gachaRepository.findOne({ where: { id } });
    if (!gacha) {
      throw new BusinessException(
        ResponseCode.NOT_FOUND,
        'Gacha not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return gacha;
  }

  /** Drop pool, rarest first (then most likely first within a tier). */
  private async loadPool(gachaId: number) {
    const pool = await this.gachaItemRepository.find({
      where: { gachaId },
      relations: ['item'],
    });
    return pool.sort(
      (a, b) =>
        RARITY_RANK[a.item.rarity] - RARITY_RANK[b.item.rarity] ||
        b.weight - a.weight,
    );
  }

  /** Each box's headline prize: rarest tier first, then most valuable. */
  private async topPrizesFor(gachaIds: number[]) {
    const prizes = new Map<
      number,
      {
        itemId: number;
        name: string;
        rarity: string;
        estimatedValue: number;
        imageUrl: string | null;
      }
    >();
    if (gachaIds.length === 0) return prizes;

    const pool = await this.gachaItemRepository.find({
      where: { gachaId: In(gachaIds) },
      relations: ['item'],
    });
    pool.sort(
      (a, b) =>
        RARITY_RANK[a.item.rarity] - RARITY_RANK[b.item.rarity] ||
        b.item.estimatedValue - a.item.estimatedValue,
    );
    for (const entry of pool) {
      if (prizes.has(entry.gachaId)) continue;
      prizes.set(entry.gachaId, {
        itemId: entry.item.id,
        name: entry.item.name,
        rarity: entry.item.rarity,
        estimatedValue: entry.item.estimatedValue,
        imageUrl: entry.item.imageUrl,
      });
    }
    return prizes;
  }

  private economyEntry(entry: GachaItem) {
    return {
      rarity: entry.item.rarity,
      weight: entry.weight,
      estimatedValue: entry.item.estimatedValue,
    };
  }
}
