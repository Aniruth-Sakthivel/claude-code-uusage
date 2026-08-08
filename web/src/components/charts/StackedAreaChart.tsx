/**
 * Usage-over-time as a stacked area chart — Overview's replacement for the
 * multi-line `TimeseriesChart`, showing both the fleet total and each
 * system's share of it at a glance.
 *
 * Truly responsive, not just fluid: width tracks the container in real
 * pixels via ResizeObserver and the SVG's viewBox is set 1:1 to that pixel
 * size, so text renders at its real size on every screen instead of shrinking
 * proportionally with a fixed internal coordinate space.
 *
 * The app's categorical palette (--pc1..--pc5) has a couple of adjacent pairs
 * with only a 6-8 CVD delta (below the ideal 8 floor) — legal only with
 * secondary encoding, which is why identity here never rests on color alone:
 * every band gets a 2px surface-color gap from its neighbours, the legend
 * pairs each swatch with its name and total, and the end-of-line total is a
 * direct label, not a color-coded number.
 */

import { useEffect, useRef, useState } from "react";

import type { Timeseries } from "../../api/types";
import { fmtTokens, systemColor } from "../../lib/format";
import { EmptyState } from "../ui";

const L = 46;
const R = 14;
const T = 16;
const B = 26;
/** 2px surface-colour seam between stacked bands, so adjacent series with a
 * marginal CVD delta are still separated by more than hue. */
const BAND_GAP = 2;

function useContainerWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}

export function StackedAreaChart({ data }: { data: Timeseries }) {
  const [containerRef, width] = useContainerWidth(760);
  const [hover, setHover] = useState<number | null>(null);

  const n = data.days.length;
  const seriesCount = data.systems.length;

  if (n === 0 || seriesCount === 0) {
    return <EmptyState title="No usage data yet" hint="Connect a PC to start collecting." />;
  }

  // Shorter on narrow screens (less clutter to fit) and a touch taller on
  // wide ones (more room for the legend row above the plot to breathe).
  const H = width < 420 ? 220 : width < 720 ? 250 : 280;
  const W = width;

  const series = data.systems.map((s, i) => ({
    id: s.system_id,
    name: s.display_name,
    color: systemColor(i),
    points: data.points.map((p) => Math.max(0, p.values[s.system_id] ?? 0)),
  }));

  const totals = data.points.map((_, dayIdx) =>
    series.reduce((sum, s) => sum + s.points[dayIdx]!, 0),
  );
  const max = Math.max(...totals) * 1.12 || 1;

  const X = (i: number) => (n <= 1 ? L + (W - L - R) / 2 : L + (i / (n - 1)) * (W - L - R));
  const Y = (v: number) => T + (H - T - B) - (v / max) * (H - T - B);
  const grid = [0, 1, 2, 3, 4].map((i) => (max * i) / 4);

  // Cumulative stack, bottom to top, in the series' fixed order — never
  // re-sorted by value, so a colour never migrates to a different system
  // between renders.
  const stackTop: number[][] = [];
  const stackBottom: number[][] = [];
  {
    let running = new Array(n).fill(0);
    for (const s of series) {
      stackBottom.push([...running]);
      running = running.map((v, i) => v + s.points[i]!);
      stackTop.push([...running]);
    }
  }

  function bandPath(seriesIdx: number, gapPx: number): string {
    const top = stackTop[seriesIdx]!;
    const bottom = stackBottom[seriesIdx]!;
    const topPts = top.map((v, i) => [X(i), Y(v) + (v > bottom[i]! ? gapPx : 0)] as const);
    const bottomPts = bottom.map((v, i) => [X(i), Y(v) - gapPx] as const);
    const forward = topPts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" L ");
    const backward = [...bottomPts]
      .reverse()
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" L ");
    return `M ${forward} L ${backward} Z`;
  }

  function pointerToIndex(clientX: number, el: SVGRectElement) {
    const svg = el.ownerSVGElement;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((sx - L) / (W - L - R)) * (n - 1));
    return Math.max(0, Math.min(n - 1, idx));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setHover((h) => {
        const cur = h ?? n - 1;
        return Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Escape") {
      setHover(null);
    }
  }

  const tooltipPct = hover === null ? 0 : (X(hover) / W) * 100;
  const clampedLeft = Math.min(88, Math.max(12, tooltipPct));
  const showXLabelEvery = width < 480 ? Math.ceil(n / 4) : width < 720 ? Math.ceil(n / 6) : Math.ceil(n / 8);

  return (
    <div ref={containerRef} className="w-full">
      {/* Legend first — pairs every colour with its name and a total, so
          identity never depends on hue discrimination alone. */}
      <ul className="mb-3 flex flex-wrap gap-2">
        {series.map((s) => {
          const total = s.points.reduce((sum, v) => sum + v, 0);
          return (
            <li
              key={s.id}
              className="inline-flex items-center gap-2 rounded-full bg-surface-2 py-1 pl-2 pr-2.5 text-xs text-ink-2"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="font-medium text-ink">{s.name}</span>
              <span className="tnum text-muted">{fmtTokens(total)}</span>
            </li>
          );
        })}
      </ul>

      <div className="relative">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="block touch-none"
          role="img"
          aria-label={`Stacked daily token usage over ${n} days across ${seriesCount} systems`}
        >
          {grid.map((v, i) => (
            <g key={i}>
              <line
                x1={L}
                x2={W - R}
                y1={Y(v)}
                y2={Y(v)}
                style={{ stroke: "var(--grid)" }}
                strokeWidth={1}
              />
              <text
                x={L - 8}
                y={Y(v) + 3.5}
                textAnchor="end"
                fontSize={10.5}
                style={{ fill: "var(--muted)", fontVariantNumeric: "tabular-nums" }}
              >
                {fmtTokens(Math.round(v))}
              </text>
            </g>
          ))}

          {data.days.map((d, i) =>
            n <= 6 || i % showXLabelEvery === 0 ? (
              <text
                key={d}
                x={X(i)}
                y={H - 8}
                textAnchor="middle"
                fontSize={10.5}
                style={{ fill: "var(--muted)" }}
              >
                {d.slice(5)}
              </text>
            ) : null,
          )}

          <line
            x1={L}
            x2={W - R}
            y1={Y(0)}
            y2={Y(0)}
            style={{ stroke: "var(--baseline)" }}
            strokeWidth={1}
          />

          {/* Bands drawn bottom-first so the gap seam of an upper band sits
              on top of the one below it, not the other way round. */}
          {series.map((s, i) => (
            <path
              key={s.id}
              d={bandPath(i, series.length > 1 ? BAND_GAP : 0)}
              fill={s.color}
              fillOpacity={0.85}
            />
          ))}

          {/* Total line on top, with a 4px rounded end anchored at the last
              day — the one direct label this chart always shows. */}
          <polyline
            fill="none"
            style={{ stroke: "var(--ink)" }}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.35}
            points={totals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}
          />
          <circle
            cx={X(n - 1)}
            cy={Y(totals[n - 1] ?? 0)}
            r={4}
            style={{ fill: "var(--ink)", stroke: "var(--surface)" }}
            strokeWidth={1.5}
          />
          <text
            x={Math.min(W - R - 4, X(n - 1) + 8)}
            y={Y(totals[n - 1] ?? 0) - 8}
            textAnchor="end"
            fontSize={11}
            fontWeight={600}
            style={{ fill: "var(--ink)" }}
          >
            {fmtTokens(totals[n - 1] ?? 0)}
          </text>

          {hover !== null && (
            <line
              x1={X(hover)}
              x2={X(hover)}
              y1={T}
              y2={H - B}
              style={{ stroke: "var(--baseline)" }}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          <rect
            x={L}
            y={T}
            width={W - L - R}
            height={H - T - B}
            fill="transparent"
            tabIndex={0}
            role="slider"
            aria-label="Inspect a day"
            aria-valuemin={0}
            aria-valuemax={n - 1}
            aria-valuenow={hover ?? n - 1}
            aria-valuetext={data.days[hover ?? n - 1]}
            onKeyDown={onKeyDown}
            onBlur={() => setHover(null)}
            onMouseMove={(e) => setHover(pointerToIndex(e.clientX, e.currentTarget))}
            onMouseLeave={() => setHover(null)}
            onTouchStart={(e) => setHover(pointerToIndex(e.touches[0]!.clientX, e.currentTarget))}
            onTouchMove={(e) => setHover(pointerToIndex(e.touches[0]!.clientX, e.currentTarget))}
          />
        </svg>

        {hover !== null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[var(--shadow)]"
            style={{ left: `${clampedLeft}%`, top: `${(T / H) * 100}%` }}
            role="status"
          >
            <div className="mb-1 text-xs font-semibold">{data.days[hover]}</div>
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-ink-2">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.name}
                <b className="tnum ml-3 text-ink">{fmtTokens(s.points[hover] ?? 0)}</b>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-line pt-1 font-semibold text-ink">
              Total
              <span className="tnum">{fmtTokens(totals[hover] ?? 0)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Screen-reader-only data table — the chart conveys the same numbers
          visually, this is the non-visual equivalent rather than a second
          on-screen UI. */}
      <table className="sr-only">
        <caption>Daily token usage by system</caption>
        <thead>
          <tr>
            <th>Day</th>
            {series.map((s) => (
              <th key={s.id}>{s.name}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {data.days.map((d, i) => (
            <tr key={d}>
              <td>{d}</td>
              {series.map((s) => (
                <td key={s.id}>{s.points[i]}</td>
              ))}
              <td>{totals[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
