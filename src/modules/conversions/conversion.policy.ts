import { createHash } from 'crypto';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ResponseCode } from '../../common/constants/response-code.constant';
import type { PrizeSnapshot } from '../orders/probability';
export const conversionError = (message: string, status = 409) =>
  new BusinessException(
    status === 404
      ? ResponseCode.NOT_FOUND
      : status === 400
        ? ResponseCode.VALIDATION_FAILED
        : ResponseCode.CONFLICT,
    message,
    status,
  );
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type ConversionPolicy = {
  version: 1;
  normalRate: 10;
  premiumRate: 100;
  restoreHours: number;
  maxRestoresPerItem: number;
  restoreRule: 'NO_GP_SPEND_SINCE_CONVERSION';
};
export function policyFrom(
  env: NodeJS.ProcessEnv = process.env,
): ConversionPolicy {
  const hours = Number(env.GP_RESTORE_WINDOW_HOURS),
    limit = Number(env.GP_RESTORE_MAX_PER_ITEM);
  if (
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 8760 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw conversionError('복구 기간·횟수 정책 설정이 필요합니다', 503);
  return {
    version: 1,
    normalRate: 10,
    premiumRate: 100,
    restoreHours: hours,
    maxRestoresPerItem: limit,
    restoreRule: 'NO_GP_SPEND_SINCE_CONVERSION',
  };
}
export function previewEnabled(env: NodeJS.ProcessEnv = process.env) {
  return (
    ['development', 'test'].includes(env.NODE_ENV ?? '') &&
    env.ENABLE_GP_CONVERSION_PREVIEW === 'true' &&
    env.ENABLE_LEGACY_TRANSACTIONS !== 'true'
  );
}
export function requirePreview() {
  if (!previewEnabled())
    throw conversionError('GP 전환 기능은 서버 검증 중입니다', 503);
}
export function normalizeIds(ids: number[]) {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 100 ||
    ids.some((id) => !Number.isInteger(id) || id < 1 || id > 2147483647) ||
    new Set(ids).size !== ids.length
  )
    throw conversionError('중복 없이 1~100개 상품을 선택해주세요', 400);
  return [...ids].sort((a, b) => a - b);
}
export function amountFrom(prize: PrizeSnapshot) {
  if (
    !prize ||
    typeof prize.isPremium !== 'boolean' ||
    !Number.isSafeInteger(prize.estimatedValue) ||
    prize.estimatedValue < 0
  )
    throw conversionError('구매 당시 상품 정책을 확인할 수 없습니다');
  const amount = prize.isPremium
    ? prize.estimatedValue
    : Math.floor(prize.estimatedValue / 10);
  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 2147483647 ||
    amount !== prize.conversionGP
  )
    throw conversionError(
      '전환 금액이 없거나 공개된 상품 정책과 일치하지 않습니다',
    );
  return amount;
}
export function validKey(key: string) {
  if (
    typeof key !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      key,
    )
  )
    throw conversionError('요청 식별번호를 확인해주세요', 400);
  return key.toLowerCase();
}
