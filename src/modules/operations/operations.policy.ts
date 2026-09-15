import { plain, fail } from '../account-support/account-support.policy';
export { fail };
export type CatalogConfig = {
  title: string;
  description: string;
  imageUrl: string | null;
  price: number;
  totalStock: number;
  saleType: 'STANDARD' | 'EVENT';
  entries: Array<{
    name: string;
    rarity: string;
    imageUrl: string | null;
    estimatedValue: number;
    isPremium: boolean;
    probabilityPpm: number;
    fulfillmentType: string;
    shippingEnabled: boolean;
    warehouseSkuId?: number | null;
  }>;
};
export function operationsEnabled(env: NodeJS.ProcessEnv = process.env) {
  return (
    ['development', 'test'].includes(env.NODE_ENV ?? '') &&
    env.ENABLE_OPERATIONS_PREVIEW === 'true' &&
    env.ENABLE_LEGACY_TRANSACTIONS !== 'true'
  );
}
export function integer(v: unknown, min: number, max = 2147483647) {
  if (!Number.isInteger(v) || Number(v) < min || Number(v) > max)
    throw fail('수량과 금액을 확인해주세요', 400);
  return v as number;
}
function image(v: unknown) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 2000)
    throw fail('이미지 주소를 확인해주세요', 400);
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && !u.username && !u.password) return u.href;
  } catch {}
  throw fail('이미지는 HTTPS 주소를 입력해주세요', 400);
}
export function catalogConfig(
  value: CatalogConfig,
  publishing = false,
): CatalogConfig {
  if (
    !value ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 100
  )
    throw fail('구성 상품은 1~100개로 입력해주세요', 400);
  if (!['STANDARD', 'EVENT'].includes(value.saleType))
    throw fail('판매 유형을 확인해주세요', 400);
  const entries = value.entries.map((e) => {
    if (
      !e ||
      !['N', 'R', 'SR', 'SSR'].includes(e.rarity) ||
      typeof e.isPremium !== 'boolean' ||
      typeof e.shippingEnabled !== 'boolean' ||
      !['PHYSICAL', 'DIGITAL', 'MANUAL'].includes(e.fulfillmentType) ||
      (e.shippingEnabled && e.fulfillmentType !== 'PHYSICAL')
    )
      throw fail('상품 등급과 배송 유형을 확인해주세요', 400);
    return {
      name: plain(e.name, 1, 255),
      rarity: e.rarity,
      imageUrl: image(e.imageUrl),
      estimatedValue: integer(e.estimatedValue, 0),
      isPremium: e.isPremium,
      probabilityPpm: integer(e.probabilityPpm, publishing ? 1 : 0, 1000000),
      fulfillmentType: e.fulfillmentType,
      shippingEnabled: e.shippingEnabled,
      warehouseSkuId:
        e.warehouseSkuId == null ? null : integer(e.warehouseSkuId, 1),
    };
  });
  const r = {
    title: plain(value.title, 2, 255),
    description: plain(value.description, 0, 2000, true),
    imageUrl: image(value.imageUrl),
    price: integer(value.price, 1, 10000000),
    totalStock: integer(value.totalStock, 0, 10000000),
    saleType: value.saleType,
    entries,
  };
  if (
    publishing &&
    entries.reduce((n, e) => n + e.probabilityPpm, 0) !== 1000000
  )
    throw fail('확률 합계가 정확히 100%여야 적용할 수 있습니다');
  return r;
}
export function shippingTransition(
  status: string,
  next: string,
  carrier?: string,
  tracking?: string,
) {
  const transitions = {
    REQUESTED: 'PREPARING',
    PREPARING: 'COLLECTED',
    COLLECTED: 'SHIPPING',
    SHIPPING: 'DELIVERED',
  };
  if (transitions[status] !== next)
    throw fail('현재 단계의 다음 배송 상태로만 변경할 수 있습니다');
  if (next === 'COLLECTED') {
    if (
      !['CJ', 'HANJIN', 'LOTTE', 'POST', 'LOGEN', 'OTHER'].includes(
        carrier ?? '',
      ) ||
      !tracking ||
      !/^[A-Za-z0-9-]{5,40}$/.test(tracking)
    )
      throw fail('택배사와 운송장 번호를 입력해주세요', 400);
  } else if (carrier !== undefined || tracking !== undefined)
    throw fail('운송장은 집화 단계에서 등록해주세요', 400);
}
