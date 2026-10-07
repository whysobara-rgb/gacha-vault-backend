/**
 * Date helpers pinned to Korea Standard Time (UTC+9, no DST), so daily
 * check-ins and monthly top-up limits roll over at KST midnight regardless
 * of the server's timezone.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' of the KST calendar day containing `date`. */
export function toKstDateString(date: Date): string {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Shifts a 'YYYY-MM-DD' string by whole days. */
export function addDays(dateString: string, days: number): string {
  const ms = Date.parse(`${dateString}T00:00:00Z`) + days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The instant the KST calendar month containing `date` started. */
export function startOfKstMonth(date: Date): Date {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  return new Date(
    Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1) - KST_OFFSET_MS,
  );
}
