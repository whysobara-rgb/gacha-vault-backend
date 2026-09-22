import {
  conversionError as fail,
  digest,
  validKey,
} from '../conversions/conversion.policy';
export { validKey };
export const preview = (env: NodeJS.ProcessEnv = process.env) =>
  ['development', 'test'].includes(env.NODE_ENV ?? '') &&
  env.ENABLE_LEGACY_TRANSACTIONS !== 'true';
export function requireRefund() {
  if (!preview() || process.env.ENABLE_ORDER_REFUND_PREVIEW !== 'true')
    throw fail('환불 기능은 서버 검증 중입니다', 503);
}
export type Calendar = {
  coverageStart: string;
  coverageEnd: string;
  holidays: string[];
};
const dateOnly = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parsed = new Date(s + 'T00:00:00Z');
  return (
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s
  );
};
export function refundCalendar(env: NodeJS.ProcessEnv = process.env): Calendar {
  let c: Calendar;
  try {
    c = JSON.parse(env.REFUND_CALENDAR_JSON || 'null');
  } catch {
    throw fail('환불 영업일 설정을 확인해주세요', 503);
  }
  if (
    !c ||
    !dateOnly(c.coverageStart) ||
    !dateOnly(c.coverageEnd) ||
    c.coverageStart > c.coverageEnd ||
    !Array.isArray(c.holidays) ||
    c.holidays.length > 1000 ||
    c.holidays.some(
      (d) => !dateOnly(d) || d < c.coverageStart || d > c.coverageEnd,
    ) ||
    new Set(c.holidays).size !== c.holidays.length
  )
    throw fail('환불 영업일 설정이 필요합니다', 503);
  return {
    coverageStart: c.coverageStart,
    coverageEnd: c.coverageEnd,
    holidays: [...c.holidays].sort(),
  };
}
// Purchase day excluded. Seventh business day ends at 23:59:59.999 Asia/Seoul.
export function refundTerms(
  createdAt: Date,
  saleType: string,
  calendar?: Calendar,
) {
  if (saleType !== 'STANDARD')
    return {
      eligible: false,
      until: null,
      policy: { version: 1, saleType, businessDays: 7 },
    };
  const c = calendar ?? refundCalendar(),
    start = new Date(createdAt.getTime() + 9 * 3600000)
      .toISOString()
      .slice(0, 10);
  if (start < c.coverageStart || start > c.coverageEnd)
    throw fail('구매일을 포함하는 환불 영업일 설정이 필요합니다', 503);
  let day = new Date(start + 'T00:00:00Z'),
    count = 0;
  for (let n = 0; count < 7 && n < 1000; n++) {
    day = new Date(day.getTime() + 86400000);
    const iso = day.toISOString().slice(0, 10);
    if (iso > c.coverageEnd)
      throw fail('환불 기한을 포함하는 영업일 설정이 필요합니다', 503);
    if (
      day.getUTCDay() !== 0 &&
      day.getUTCDay() !== 6 &&
      !c.holidays.includes(iso)
    )
      count++;
  }
  if (count !== 7) throw fail('환불 영업일을 계산할 수 없습니다', 503);
  return {
    eligible: true,
    until: new Date(day.getTime() + 86400000 - 9 * 3600000 - 1),
    policy: {
      version: 1,
      saleType,
      businessDays: 7,
      timeZone: 'Asia/Seoul',
      purchaseDayExcluded: true,
      calendarVersion: digest(c),
    },
  };
}
export function capsuleIds(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 100)
    throw fail('캡슐을 1~100개 선택해주세요', 400);
  const ids = v.map(validKey).sort();
  if (new Set(ids).size !== ids.length)
    throw fail('캡슐을 중복 없이 선택해주세요', 400);
  return ids;
}
export const validatePage = (page: number, limit: number) => {
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw fail('페이지를 확인해주세요', 400);
};
