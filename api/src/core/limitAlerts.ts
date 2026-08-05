/**
 * Rate-limit alerting for Claude accounts.
 *
 * The agent re-reports utilisation on every sync cycle — as often as once a
 * minute under the daemon. Alerting on "percent is above 80" would therefore
 * produce an identical notification every cycle until the window reset, and a
 * bell that cries wolf sixty times an hour is one nobody reads.
 *
 * So alerts fire on an upward *crossing* of a threshold, not on the level. The
 * previous reading is the state: 78 → 82 alerts once, 82 → 85 → 89 stays quiet,
 * and a reset back to 4 → 81 alerts again because it genuinely crossed again.
 */

/** Percent points at which someone wants to hear about it. */
export const THRESHOLDS = [80, 95] as const;

export type AlertLevel = "warning" | "error";

export interface LimitReading {
  /** "session" (5-hour window) or a weekly kind. */
  kind: string;
  /** Human label for the window, e.g. "weekly (all models)". */
  scopeLabel: string;
  percent: number;
}

export interface LimitAlert {
  kind: string;
  scopeLabel: string;
  percent: number;
  threshold: number;
  level: AlertLevel;
}

/** Highest threshold at or below `percent`, or null when under them all. */
function bandOf(percent: number): number | null {
  let band: number | null = null;
  for (const t of THRESHOLDS) if (percent >= t) band = t;
  return band;
}

/**
 * Which alerts a new reading warrants, given the previous one.
 *
 * `previous` is keyed by limit kind. A kind absent from it is a first reading:
 * it alerts if already over a threshold, since a machine that comes online at
 * 97% is exactly the case worth hearing about.
 */
export function alertsForReading(
  readings: LimitReading[],
  previous: Map<string, number>,
): LimitAlert[] {
  const out: LimitAlert[] = [];

  for (const reading of readings) {
    if (!Number.isFinite(reading.percent)) continue;

    const nowBand = bandOf(reading.percent);
    if (nowBand === null) continue;

    const before = previous.get(reading.kind);
    const beforeBand = before === undefined ? null : bandOf(before);

    // Quiet unless this reading entered a higher band than the last one. A
    // climb inside the same band, or any fall, says nothing new.
    if (beforeBand !== null && beforeBand >= nowBand) continue;

    out.push({
      kind: reading.kind,
      scopeLabel: reading.scopeLabel,
      percent: reading.percent,
      threshold: nowBand,
      level: nowBand >= 95 ? "error" : "warning",
    });
  }

  return out;
}

/** Notification title, e.g. "Claude limit at 95% — weekly (all models)". */
export function alertTitle(alert: LimitAlert): string {
  const window = alert.scopeLabel || (alert.kind === "session" ? "5-hour window" : alert.kind);
  return `Claude limit at ${Math.round(alert.percent)}% — ${window}`;
}

export function alertBody(alert: LimitAlert, accountLabel: string): string {
  const window = alert.scopeLabel || (alert.kind === "session" ? "the 5-hour window" : alert.kind);
  return alert.level === "error"
    ? `${accountLabel} has used ${Math.round(alert.percent)}% of ${window}. Work on this account may stop shortly.`
    : `${accountLabel} has passed ${alert.threshold}% of ${window}.`;
}
