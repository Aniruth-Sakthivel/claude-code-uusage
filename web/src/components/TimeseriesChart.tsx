import { useMemo, useRef, useState } from "react";
import type { Timeseries } from "../api/types";
import { fmtTokens, systemColor } from "../lib/format";

const W = 760, H = 280, L = 46, R = 14, T = 14, B = 26;

export function TimeseriesChart({ data }: { data: Timeseries }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const series = data.systems.map((s, i) => ({
    id: s.system_id, name: s.display_name, color: systemColor(i),
    points: data.points.map((p) => p.values[s.system_id] ?? 0),
  }));
  const n = data.days.length;

  const max = useMemo(() => {
    let m = 0;
    for (const s of series) for (const v of s.points) if (v > m) m = v;
    return m * 1.12 || 1;
  }, [data]);

  const X = (i: number) => (n <= 1 ? L + (W - L - R) / 2 : L + (i / (n - 1)) * (W - L - R));
  const Y = (v: number) => T + (H - T - B) - (v / max) * (H - T - B);

  const grid = [0, 1, 2, 3, 4].map((i) => (max * i) / 4);

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((sx - L) / (W - L - R)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  }

  return (
    <div ref={wrapRef} className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Usage over time by system">
        {grid.map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} style={{ stroke: "var(--grid)" }} strokeWidth={1} />
            <text x={L - 8} y={Y(v) + 3.5} textAnchor="end" fontSize={10.5}
              style={{ fill: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{fmtTokens(Math.round(v))}</text>
          </g>
        ))}
        {data.days.map((d, i) =>
          (n <= 10 || i % Math.ceil(n / 8) === 0) ? (
            <text key={d} x={X(i)} y={H - 8} textAnchor="middle" fontSize={10.5} style={{ fill: "var(--muted)" }}>
              {d.slice(5)}
            </text>
          ) : null)}
        <line x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} style={{ stroke: "var(--baseline)" }} strokeWidth={1} />

        {series.map((s) => (
          <g key={s.id}>
            <polyline fill="none" style={{ stroke: s.color }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
              points={s.points.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")} />
            <circle cx={X(n - 1)} cy={Y(s.points[n - 1] ?? 0)} r={3.5} style={{ fill: s.color, stroke: "var(--surface)" }} strokeWidth={1.5} />
          </g>
        ))}

        {hover !== null && (
          <>
            <line x1={X(hover)} x2={X(hover)} y1={T} y2={H - B} style={{ stroke: "var(--baseline)" }} strokeWidth={1} strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.id} cx={X(hover)} cy={Y(s.points[hover] ?? 0)} r={4} style={{ fill: s.color, stroke: "var(--surface)" }} strokeWidth={1.5} />
            ))}
          </>
        )}
        <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>

      {hover !== null && (
        <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-lg border px-3 py-2 text-[12px]"
          style={{
            left: `${(X(hover) / W) * 100}%`, top: `${(T / H) * 100}%`,
            background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)", whiteSpace: "nowrap",
          }}>
          <div className="mb-1 text-[11.5px] font-semibold">{data.days[hover]}</div>
          {series.map((s) => (
            <div key={s.id} className="flex items-center gap-2" style={{ color: "var(--ink-2)" }}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.name}
              <b className="tnum ml-3" style={{ color: "var(--ink)" }}>{fmtTokens(s.points[hover] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
