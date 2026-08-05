export function fmtTokens(n: number): string {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "K";
  return String(n);
}

export function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Stable per-system color from the token palette (max 5 named, then cycle).
const SERIES = ["--pc1", "--pc2", "--pc3", "--pc4", "--pc5"];
export function systemColor(index: number): string {
  return `var(${SERIES[index % SERIES.length]})`;
}

/** Rate-limit percentages arrive as 0-100 already, not as a fraction. */
export function fmtPct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
}

export function fmtDollars(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}

/**
 * "in 41m" — how long until a rate-limit window resets. Counts forward, where
 * fmtRelative counts backward, so the two read correctly side by side.
 */
/** Calendar date, e.g. "17 Mar 2026". Used where a day matters, not a time. */
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function fmtResetsIn(iso: string | null): string {
  if (!iso) return "—";
  const secs = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (secs <= 0) return "due";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
  return `in ${Math.round(hrs / 24)}d`;
}
