import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';

const SOURCE = 'CONFIRMED_CAPSULE_OPENINGS_V1';
// Old demo Draw records are deliberately absent from public rankings.
const CONFIRMED = `
  FROM capsule_openings opening
  JOIN owned_capsules capsule ON capsule.id = opening.capsule_id AND capsule.status = 'OPENED'
  JOIN capsule_orders orders ON orders.id = capsule.order_id AND orders.status = 'PAID'
  JOIN users account ON account.id = orders.user_id
`;

@Injectable()
export class RankingsService {
  constructor(private readonly dataSource: DataSource) {}

  private limit(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new BusinessException(
        ResponseCode.VALIDATION_FAILED,
        '조회 개수는 1~100 사이여야 합니다',
        HttpStatus.BAD_REQUEST,
      );
    }
    return value;
  }

  async getUserRanking(limit = 50) {
    const rows = await this.dataSource.query(
      `
      SELECT account.id AS "userId", account.nickname, COUNT(*)::int AS "drawCount",
        COALESCE(SUM((opening.prize->>'estimatedValue')::bigint), 0)::text AS "totalValue"
      ${CONFIRMED}
      GROUP BY account.id, account.nickname
      ORDER BY SUM((opening.prize->>'estimatedValue')::bigint) DESC, COUNT(*) DESC, account.id ASC
      LIMIT $1`,
      [this.limit(limit)],
    );
    return {
      source: SOURCE,
      items: rows.map((row, index) => ({
        rank: index + 1,
        userId: row.userId,
        nickname: maskNickname(row.nickname),
        drawCount: row.drawCount,
        totalValue: Number(row.totalValue),
      })),
    };
  }

  async getPopularGachas(limit = 20) {
    const rows = await this.dataSource.query(
      `
      SELECT gacha.id AS "gachaId", gacha.title, gacha."imageUrl" AS "imageUrl",
        gacha."accentColorHex" AS "accentColorHex", gacha.price, COUNT(*)::int AS "drawCount"
      ${CONFIRMED}
      JOIN gachas gacha ON gacha.id = orders.gacha_id AND gacha.active = true
      GROUP BY gacha.id
      ORDER BY COUNT(*) DESC, gacha.id ASC
      LIMIT $1`,
      [this.limit(limit)],
    );
    return {
      source: SOURCE,
      items: rows.map((row, index) => ({ ...row, rank: index + 1 })),
    };
  }

  async getRecentBigWins(limit = 30) {
    const rows = await this.dataSource.query(
      `
      SELECT opening.inventory_item_id AS "inventoryItemId", account.nickname,
        orders.title_snapshot AS "gachaTitle", opening.prize, opening.opened_at AS "wonAt"
      ${CONFIRMED}
      ORDER BY opening.opened_at DESC, opening.capsule_id DESC
      LIMIT $1`,
      [this.limit(limit)],
    );
    return {
      source: SOURCE,
      items: rows.map((row) => ({
        inventoryItemId: row.inventoryItemId,
        nickname: maskNickname(row.nickname),
        gachaTitle: row.gachaTitle,
        itemName: row.prize.name,
        rarity: row.prize.rarity,
        estimatedValue: row.prize.estimatedValue,
        imageUrl: row.prize.imageUrl,
        wonAt: row.wonAt,
      })),
    };
  }
}

function maskNickname(nickname: string): string {
  const characters = Array.from(nickname);
  return characters.length <= 1 ? nickname : characters[0] + '**';
}
