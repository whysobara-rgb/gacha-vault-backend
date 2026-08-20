import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Draw, InventoryItem, User } from '../../entities';

@Injectable()
export class RankingsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Top users ranked by lifetime total estimated value won (sum of
   * inventory item estimatedValue joined through their draws), tie-broken
   * by draw count. Mirrors a typical gacha app "명예의 전당" leaderboard.
   */
  async getUserRanking(limit = 50) {
    const rows: Array<{
      userId: number;
      nickname: string;
      drawCount: string;
      totalValue: string | null;
    }> = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('user')
      .innerJoin('user.draws', 'draw')
      .leftJoin('draw.inventoryItem', 'inventoryItem')
      .leftJoin('inventoryItem.item', 'item')
      .select('user.id', 'userId')
      .addSelect('user.nickname', 'nickname')
      .addSelect('COUNT(DISTINCT draw.id)', 'drawCount')
      .addSelect('COALESCE(SUM(item.estimatedValue), 0)', 'totalValue')
      .groupBy('user.id')
      .addGroupBy('user.nickname')
      .orderBy('"totalValue"', 'DESC')
      .addOrderBy('"drawCount"', 'DESC')
      .limit(limit)
      .getRawMany();

    return {
      items: rows.map((row, index) => ({
        rank: index + 1,
        userId: row.userId,
        nickname: row.nickname,
        drawCount: Number(row.drawCount),
        totalValue: Number(row.totalValue ?? 0),
      })),
    };
  }

  /**
   * Most-drawn gachas over all time — powers a "지금 가장 인기있는 박스"
   * ranking tab, independent from the home screen's default ordering.
   */
  async getPopularGachas(limit = 20) {
    const rows: Array<{
      gachaId: number;
      title: string;
      imageUrl: string | null;
      accentColorHex: string | null;
      price: string;
      drawCount: string;
    }> = await this.dataSource
      .getRepository(Draw)
      .createQueryBuilder('draw')
      .innerJoin('draw.gacha', 'gacha')
      .select('gacha.id', 'gachaId')
      .addSelect('gacha.title', 'title')
      .addSelect('gacha.imageUrl', 'imageUrl')
      .addSelect('gacha.accentColorHex', 'accentColorHex')
      .addSelect('gacha.price', 'price')
      .addSelect('COUNT(draw.id)', 'drawCount')
      .where('gacha.active = :active', { active: true })
      .groupBy('gacha.id')
      .orderBy('"drawCount"', 'DESC')
      .limit(limit)
      .getRawMany();

    return {
      items: rows.map((row, index) => ({
        rank: index + 1,
        gachaId: row.gachaId,
        title: row.title,
        imageUrl: row.imageUrl,
        accentColorHex: row.accentColorHex,
        price: Number(row.price),
        drawCount: Number(row.drawCount),
      })),
    };
  }

  /**
   * Most recent high-value wins across all users — powers a "실시간 당첨"
   * feed tab (richer than the home screen's scrolling ticker: includes
   * item image + masked nickname + rarity).
   */
  async getRecentBigWins(limit = 30) {
    const rows: InventoryItem[] = await this.dataSource
      .getRepository(InventoryItem)
      .createQueryBuilder('inventoryItem')
      .innerJoinAndSelect('inventoryItem.item', 'item')
      .innerJoinAndSelect('inventoryItem.user', 'user')
      .innerJoinAndSelect('inventoryItem.draw', 'draw')
      .innerJoinAndSelect('draw.gacha', 'gacha')
      .orderBy('inventoryItem.createdAt', 'DESC')
      .limit(limit)
      .getMany();

    return {
      items: rows.map((row) => ({
        inventoryItemId: row.id,
        nickname: maskNickname(row.user.nickname),
        gachaTitle: row.draw?.gacha?.title ?? '',
        itemName: row.item.name,
        rarity: row.item.rarity,
        estimatedValue: row.item.estimatedValue,
        imageUrl: row.item.imageUrl,
        wonAt: row.createdAt,
      })),
    };
  }
}

/** "김철수" -> "김**" style masking for public leaderboard/feed display. */
function maskNickname(nickname: string): string {
  if (nickname.length <= 1) return nickname;
  return nickname[0] + '*'.repeat(Math.min(nickname.length - 1, 2));
}
