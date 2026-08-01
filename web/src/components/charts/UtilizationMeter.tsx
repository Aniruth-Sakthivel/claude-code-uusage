/**
 * Rate-limit utilization bar.
 *
 * Unlike every other figure in this app, this one is not an estimate — it is
 * the quota position Claude Code itself reports, and its colour follows
 * Anthropic's own `severity` verdict where one is available (see
 * `api/src/core/plans.ts`). Built from divs, matching `RankingBars`.
 */

import { fmtPct, fmtResetsIn } from "../../lib/format";

export type Health = "healthy" | "moderate" | "heavy" | "unknown";

const TRACK_COLOR: Record<Health, string> = {
  healthy: "var(--good)",
  moderate: "var(--warn)",
  heavy: "var(--critical)",
  unknown: "var(--muted)",
};

export function UtilizationMeter({
  percent,
  health = "unknown",
  label,
  resetsAt,
  compact = false,
}: {
  percent: number | null;
  health?: Health;
  label?: string;
  resetsAt?: string | null;
  /** Drops the caption row — for use inside a dense table cell. */
  compact?: boolean;
}) {
  const known = percent !== null && !Number.isNaN(percent);
  // Clamp only the bar width; the printed figure stays truthful if a window
  // ever reports over 100.
  const width = known ? Math.min(100, Math.max(0, percent)) : 0;
  const color = TRACK_COLOR[health];

  return (
    <div className="min-w-[7rem]">
      {!compact && label && (
        <div className="faceplate mb-1 text-2xs text-muted">{label}</div>
      )}
      <div className="flex items-center gap-2">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
          role="meter"
          aria-valuenow={known ? Math.round(percent) : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label ?? "Utilization"}
        >
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{ width: `${width}%`, background: color }}
          />
        </div>
        <span className="tnum shrink-0 text-sm font-semibold" style={{ color }}>
          {fmtPct(known ? percent : null)}
        </span>
      </div>
      {!compact && resetsAt && (
        <div className="tnum mt-0.5 text-2xs text-muted">resets {fmtResetsIn(resetsAt)}</div>
      )}
    </div>
  );
}
