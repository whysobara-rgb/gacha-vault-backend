import { EntityManager } from 'typeorm';
import { conversionError as fail } from '../conversions/conversion.policy';
export async function lockUser(m: EntityManager, id: number) {
  if (!Number.isInteger(id) || id < 1) throw fail('계정을 확인해주세요', 400);
  const [u] = await m.query(
    'SELECT id,"coinBalance" AS balance FROM users WHERE id=$1 FOR UPDATE',
    [id],
  );
  if (!u) throw fail('계정을 찾을 수 없습니다', 404);
  if (
    BigInt(u.balance) < 0n ||
    BigInt(u.balance) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw fail('잔액을 확인해주세요');
  return u;
}
export const reservedStockSql = `SELECT COALESCE(sum(quantity),0) AS reserved FROM payment_intents WHERE gacha_id=$1 AND (status IN('CONFIRMING','UNKNOWN','APPROVED') OR (status IN('PREPARED','AUTHENTICATED') AND expires_at>clock_timestamp()))`;
