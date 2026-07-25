/**
 * Usage-over-time chart (hand-rolled SVG — no charting dependency).
 *
 * Fixes over the previous version:
 *   - empty `days` produced `X(-1)` and NaN coordinates, rendering nothing
 *   - the `useMemo` deps listed `[data]` while the body read `series`
 *   - hover was mouse-only; it now supports keyboard and touch
 *   - no legend, so colors were unattributable
 */

import { useMemo, useState } from "react";

import type { Timeseries } from "../../api/types";
import { fmtTokens, systemColor } from "../../lib/format";
import { EmptyState } from "../ui";

const W = 760;
const H = 280;
const L = 46;
const R = 14;
const T = 14;
const B = 26;

export function TimeseriesChart({ data }: { data: Timeseries }) {
  const [hover, setHover] = useState<number | null>(null);

  const series = useMemo(
    () =>
      data.systems.map((s, i) => ({
        id: s.system_id,
        name: s.display_name,
        color: systemColor(i),
        points: data.points.map((p) => p.values[s.system_id] ?? 0),
      })),
    [data.systems, data.points],
  );

  const max = useMemo(() => {
    let m = 0;
    for (const s of series) for (const v of s.points) if (v > m) m = v;
    return m * 1.12 || 1;
  }, [series]);

  const n = data.days.length;

  // Guard: without this, X(n - 1) with n === 0 yields NaN and the SVG is blank.
  if (n === 0 || series.length === 0) {
    return <EmptyState title="No usage data yet" hint="Connect a PC to start collecting." />;
  }

  const X = (i: number) => (n <= 1 ? L + (W - L - R) / 2 : L + (i / (n - 1)) * (W - L - R));
  const Y = (v: number) => T + (H - T - B) - (v / max) * (H - T - B);
  const grid = [0, 1, 2, 3, 4].map((i) => (max * i) / 4);

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

  // Keep the tooltip inside the container near the edges.
  const tooltipPct = hover === null ? 0 : (X(hover) / W) * 100;
  const clampedLeft = Math.min(88, Math.max(12, tooltipPct));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full touch-none"
        role="img"
        aria-label={`Usage over ${n} days across ${series.length} systems`}
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
          n <= 10 || i % Math.ceil(n / 8) === 0 ? (
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

        {series.map((s) => (
          <g key={s.id}>
            <polyline
              fill="none"
              style={{ stroke: s.color }}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={s.points.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}
            />
            <circle
              cx={X(n - 1)}
              cy={Y(s.points[n - 1] ?? 0)}
              r={3.5}
              style={{ fill: s.color, stroke: "var(--surface)" }}
              strokeWidth={1.5}
            />
          </g>
        ))}

        {hover !== null && (
          <>
            <line
              x1={X(hover)}
              x2={X(hover)}
              y1={T}
              y2={H - B}
              style={{ stroke: "var(--baseline)" }}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {series.map((s) => (
              <circle
                key={s.id}
                cx={X(hover)}
                cy={Y(s.points[hover] ?? 0)}
                r={4}
                style={{ fill: s.color, stroke: "var(--surface)" }}
                strokeWidth={1.5}
              />
            ))}
          </>
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
          onTouchStart={(e) =>
            setHover(pointerToIndex(e.touches[0]!.clientX, e.currentTarget))
          }
          onTouchMove={(e) => setHover(pointerToIndex(e.touches[0]!.clientX, e.currentTarget))}
        />
      </svg>

      {hover !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[var(--shadow)]"
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
        </div>
      )}

      {/* Legend — previously absent, so colors could not be attributed. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-xs text-ink-2">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
            {s.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
