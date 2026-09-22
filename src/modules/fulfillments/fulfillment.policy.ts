import {
  conversionError as fail,
  digest,
  normalizeIds,
} from '../conversions/conversion.policy';
export type Recipient = {
  name: string;
  phone: string;
  postalCode: string;
  address1: string;
  address2: string;
  notes: string;
  country: 'KR';
};
export type RateZone = {
  id: string;
  label: string;
  prefixes: string[];
  feeGP: number;
};
export function shippingEnabled(env: NodeJS.ProcessEnv = process.env) {
  return (
    ['development', 'test'].includes(env.NODE_ENV ?? '') &&
    env.ENABLE_SHIPPING_PREVIEW === 'true' &&
    env.ENABLE_LEGACY_TRANSACTIONS !== 'true'
  );
}
export function requireShipping() {
  if (!shippingEnabled()) throw fail('배송 기능은 서버 검증 중입니다', 503);
}
export function rateTable(env: NodeJS.ProcessEnv = process.env): RateZone[] {
  let rows: RateZone[];
  try {
    rows = JSON.parse(env.SHIPPING_RATE_TABLE_JSON || 'null');
  } catch {
    throw fail('배송비 정책 설정을 확인해주세요', 503);
  }
  if (!Array.isArray(rows) || !rows.length || rows.length > 20)
    throw fail('배송비 정책 설정이 필요합니다', 503);
  const names = new Set(),
    prefixes = new Set();
  for (const r of rows) {
    if (
      !r ||
      typeof r.id !== 'string' ||
      !r.id ||
      r.id.length > 50 ||
      names.has(r.id) ||
      typeof r.label !== 'string' ||
      !r.label.trim() ||
      r.label.length > 100 ||
      !Number.isInteger(r.feeGP) ||
      r.feeGP < 0 ||
      r.feeGP > 10000000 ||
      !Array.isArray(r.prefixes) ||
      !r.prefixes.length ||
      r.prefixes.length > 1000
    )
      throw fail('배송비 정책 설정을 확인해주세요', 503);
    names.add(r.id);
    for (const p of r.prefixes) {
      if (
        typeof p !== 'string' ||
        !/^([0-9]{2,5}|\*)$/.test(p) ||
        prefixes.has(p)
      )
        throw fail('배송 지역 설정이 중복되거나 올바르지 않습니다', 503);
      prefixes.add(p);
    }
  }
  return rows
    .map((r) => ({
      id: r.id,
      label: r.label.trim(),
      feeGP: r.feeGP,
      prefixes: [...r.prefixes].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function zoneFor(postalCode: string, rates = rateTable()) {
  const matches = rates
    .flatMap((r) =>
      r.prefixes
        .filter((p) => p === '*' || postalCode.startsWith(p))
        .map((p) => ({ r, score: p === '*' ? 0 : p.length })),
    )
    .sort((a, b) => b.score - a.score);
  if (!matches.length) throw fail('현재 배송을 지원하지 않는 우편번호입니다');
  const r = matches[0].r;
  return { id: r.id, label: r.label, feeGP: r.feeGP };
}
export function recipientFrom(body: any): Recipient {
  const field = (key: string, min: number, max: number) => {
    if (typeof body?.[key] !== 'string')
      throw fail('수령 정보와 주소를 확인해주세요', 400);
    const x = body[key].trim();
    if (x.length < min || x.length > max || /[\u0000-\u001f\u007f]/.test(x))
      throw fail('수령 정보와 주소를 확인해주세요', 400);
    return x;
  };
  const name = field('name', 1, 100),
    phone = field('phone', 9, 20).replace(/-/g, ''),
    postalCode = field('postalCode', 5, 5),
    address1 = field('address1', 5, 180),
    address2 = field('address2', 1, 100),
    notes = body?.notes == null ? '' : field('notes', 0, 300);
  if (
    !/^0\d{8,10}$/.test(phone) ||
    !/^\d{5}$/.test(postalCode) ||
    body?.country !== 'KR'
  )
    throw fail('국내 연락처와 5자리 우편번호를 확인해주세요', 400);
  return { name, phone, postalCode, address1, address2, notes, country: 'KR' };
}
export function quoteInput(body: any) {
  return {
    inventoryItemIds: normalizeIds(body?.inventoryItemIds),
    recipient: recipientFrom(body?.recipient),
  };
}
export const tariffVersion = () => digest(rateTable());
