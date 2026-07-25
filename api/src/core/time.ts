/**
 * UTC date helpers.
 *
 * Usage events are bucketed into `day` using UTC (the agent normalizes every
 * transcript timestamp to UTC before storing it). The Python server compared
 * those buckets against `date.today()`, which is *server-local* — so on any
 * non-UTC host "today's tokens" silently queried the wrong day for several
 * hours around midnight. Everything here is explicitly UTC to close that gap.
 */

/** Today's UTC day bucket, `YYYY-MM-DD`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The UTC day bucket `n` days before `now` (0 = today). */
export function daysAgoUtc(n: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** First day of the current UTC month, `YYYY-MM-DD`. */
export function monthStartUtc(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

/** Inclusive list of the last `days` UTC day buckets, oldest first. */
export function lastNDaysUtc(days: number, now: Date = new Date()): string[] {
  return Array.from({ length: days }, (_, i) => daysAgoUtc(days - 1 - i, now));
}

/** A system is "online" if it checked in within this window. */
export const ONLINE_WINDOW_MS = 10 * 60 * 1000;

export function isOnline(lastSeenAt: Date | null, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() <= ONLINE_WINDOW_MS;
}
