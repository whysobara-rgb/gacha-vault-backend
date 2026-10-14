import { createHash, randomInt } from 'crypto';
import { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
export type PrizeSnapshot = {
  itemId: number;
  name: string;
  rarity: string;
  imageUrl: string | null;
  estimatedValue: number;
  isPremium: boolean;
  conversionGP: number;
  probabilityPpm: number;
};
export type ProbabilitySnapshot = {
  schemaVersion: 1;
  mode: 'FIXED_PPM';
  entries: PrizeSnapshot[];
};
const invalid = () =>
  new BusinessException(
    ResponseCode.CONFLICT,
    '확률·상품 설정을 확인해 주세요',
    409,
  );
export function normalizeSnapshot(
  input: ProbabilitySnapshot,
): ProbabilitySnapshot {
  if (
    !input ||
    input.schemaVersion !== 1 ||
    input.mode !== 'FIXED_PPM' ||
    !Array.isArray(input.entries) ||
    input.entries.length === 0 ||
    input.entries.length > 1000
  )
    throw invalid();
  const seen = new Set<number>();
  const entries = input.entries
    .map((e) => {
      if (
        !e ||
        !Number.isInteger(e.itemId) ||
        e.itemId < 1 ||
        seen.has(e.itemId) ||
        typeof e.name !== 'string' ||
        !e.name.trim() ||
        !['N', 'R', 'SR', 'SSR'].includes(e.rarity) ||
        (e.imageUrl !== null && typeof e.imageUrl !== 'string') ||
        !Number.isInteger(e.estimatedValue) ||
        e.estimatedValue < 0 ||
        typeof e.isPremium !== 'boolean' ||
        !Number.isInteger(e.conversionGP) ||
        e.conversionGP < 0 ||
        e.conversionGP > 2147483647 ||
        !Number.isInteger(e.probabilityPpm) ||
        e.probabilityPpm < 1 ||
        e.probabilityPpm > 1000000
      )
        throw invalid();
      seen.add(e.itemId);
      return {
        itemId: e.itemId,
        name: e.name,
        rarity: e.rarity,
        imageUrl: e.imageUrl,
        estimatedValue: e.estimatedValue,
        isPremium: e.isPremium,
        conversionGP: e.conversionGP,
        probabilityPpm: e.probabilityPpm,
      };
    })
    .sort((a, b) => a.itemId - b.itemId);
  if (entries.reduce((sum, e) => sum + e.probabilityPpm, 0) !== 1000000)
    throw invalid();
  return { schemaVersion: 1, mode: 'FIXED_PPM', entries };
}
export function probabilityVersion(snapshot: ProbabilitySnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeSnapshot(snapshot)))
    .digest('hex');
}
export async function loadProbability(manager: EntityManager, gachaId: number) {
  // One SQL statement provides a consistent MVCC view of all joined fields.
  const entries = await manager.query(
    `SELECT i.id AS "itemId", i.name, i.rarity, i."imageUrl", i."estimatedValue", i."isPremium", i."conversionGP", p."probabilityPpm" FROM gacha_items p JOIN items i ON i.id = p.item_id WHERE p.gacha_id = $1 ORDER BY i.id`,
    [gachaId],
  );
  const snapshot = normalizeSnapshot({
    schemaVersion: 1,
    mode: 'FIXED_PPM',
    entries,
  });
  return { snapshot, version: probabilityVersion(snapshot) };
}
export function selectPrize(
  snapshot: ProbabilitySnapshot,
  ticket = randomInt(1000000),
): PrizeSnapshot {
  if (!Number.isInteger(ticket) || ticket < 0 || ticket >= 1000000)
    throw invalid();
  let upper = 0;
  for (const prize of normalizeSnapshot(snapshot).entries) {
    upper += prize.probabilityPpm;
    if (ticket < upper) return prize;
  }
  throw invalid();
}
