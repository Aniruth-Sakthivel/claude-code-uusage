/**
 * Small hand-rolled bar charts for the Reports page — no charting
 * dependency, matching the app's existing convention (see
 * components/charts/TimeseriesChart.tsx). Kept intentionally simple: flex
 * divs with a width percentage, not SVG, since these are single-measure
 * magnitude bars rather than a multi-series plot with hover/zoom needs.
 */

interface Bar {
  label: string;
  value: number;
  color: string; // a CSS color, e.g. "var(--accent)"
}

/** Horizontal bars: one row per category, direct-labeled with its count so
 * identity/value never depend on color alone. */
export function HorizontalBars({ bars }: { bars: Bar[] }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div className="flex flex-col gap-2.5">
      {bars.map((b) => (
        <div key={b.label} className="flex items-center gap-3">
          <div className="w-28 shrink-0 truncate text-sm text-ink-2" title={b.label}>
            {b.label}
          </div>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{ width: `${(b.value / max) * 100}%`, background: b.color }}
            />
          </div>
          <div className="w-8 shrink-0 text-right text-sm tnum text-ink">{b.value}</div>
        </div>
      ))}
    </div>
  );
}

/** 14 daily columns — a compact trend, not a full time-series with hover
 * (see TimeseriesChart for that pattern when one is actually needed). */
export function TrendBars({ data }: { data: { day: string; n: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return (
    <div className="flex h-24 items-end gap-1.5">
      {data.map((d) => (
        <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.n}`}>
          <div
            className="w-full rounded-t-sm bg-accent"
            style={{ height: `${Math.max(4, (d.n / max) * 80)}px` }}
          />
          <span className="text-2xs text-muted">{d.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}
