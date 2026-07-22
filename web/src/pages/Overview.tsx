import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { RankingItem, Summary, SystemRow, Timeseries } from "../api/types";
import { Card, CardHead, Eyebrow, EmptyState, Spinner, StatusPill } from "../components/ui";
import { RankingBars } from "../components/RankingBars";
import { TimeseriesChart } from "../components/TimeseriesChart";
import { fmtTokens, fmtRelative, systemColor } from "../lib/format";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

export function Overview() {
  const [range, setRange] = useState("7d");

  const summary = useQuery({ queryKey: ["summary"], queryFn: () => api.get<Summary>("/api/v1/dashboard/summary") });
  const ranking = useQuery({ queryKey: ["ranking", range], queryFn: () => api.get<RankingItem[]>(`/api/v1/dashboard/ranking?range=${range}`) });
  const ts = useQuery({ queryKey: ["timeseries", range], queryFn: () => api.get<Timeseries>(`/api/v1/dashboard/timeseries?range=${range}`) });
  const systems = useQuery({ queryKey: ["systems"], queryFn: () => api.get<SystemRow[]>("/api/v1/systems") });

  const s = summary.data;

  const tiles = [
    { lbl: "Today", val: s ? fmtTokens(s.today_tokens) : "—", sub: "tracked tokens" },
    { lbl: "This week", val: s ? fmtTokens(s.week_tokens) : "—", sub: "last 7 days" },
    { lbl: "This month", val: s ? fmtTokens(s.month_tokens) : "—", sub: "month to date" },
    { lbl: "Total", val: s ? fmtTokens(s.total_tokens) : "—", sub: "all-time" },
    { lbl: "Active systems", val: s ? `${s.active_systems} / ${s.total_systems}` : "—", sub: "online now" },
    { lbl: "Highest consumer", val: s?.highest?.display_name ?? "—", sub: s?.highest ? `${fmtTokens(s.highest.total_tokens)} total` : "no data", accent: true },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[21px] font-semibold tracking-tight">Which PC is using the most?</h2>
          <p className="text-[13.5px]" style={{ color: "var(--ink-2)" }}>Tracked Claude Code token activity across your fleet.</p>
        </div>
        <div className="inline-flex rounded-lg border p-0.5" style={{ background: "var(--surface-2)", borderColor: "var(--border)" }}>
          {RANGES.map((r) => (
            <button key={r.id} onClick={() => setRange(r.id)}
              className="rounded-md px-3 py-1.5 text-[12.5px] font-semibold"
              style={range === r.id ? { background: "var(--surface)", color: "var(--ink)", boxShadow: "var(--shadow)" } : { color: "var(--ink-2)" }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-5 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]"
        style={{ background: "var(--surface)", borderColor: "var(--border)", borderLeft: "3px solid var(--accent)", color: "var(--ink-2)" }}>
        <b>Tracked activity, not billing.</b> Token counts from local transcripts — an estimate, not official Claude Max/Pro quota.
      </div>

      <div className="mb-5 grid gap-3" style={{ gridTemplateColumns: "repeat(6, minmax(0,1fr))" }}>
        {tiles.map((t) => (
          <Card key={t.lbl} className="!p-4">
            <Eyebrow>{t.lbl}</Eyebrow>
            <div className={`mt-2 font-semibold tracking-tight ${t.accent ? "text-[17px]" : "text-[22px]"}`}
              style={t.accent ? { color: "var(--accent)" } : undefined}>{t.val}</div>
            <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--ink-2)" }}>{t.sub}</div>
          </Card>
        ))}
      </div>

      <Card className="mb-4">
        <CardHead title="Fleet ranking" hint={RANGES.find((r) => r.id === range)?.label} />
        {ranking.isLoading ? <Spinner /> : <RankingBars items={ranking.data ?? []} />}
      </Card>

      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr" }}>
        <Card>
          <CardHead title="Usage over time" hint="Tracked tokens per system" />
          {ts.isLoading ? <Spinner /> : ts.data && ts.data.systems.length > 0
            ? <TimeseriesChart data={ts.data} />
            : <EmptyState title="No usage yet" hint="Once agents sync, activity appears here." />}
        </Card>

        <Card>
          <CardHead title="Systems" hint="Status & activity" />
          {systems.isLoading ? <Spinner /> : (systems.data?.length ?? 0) === 0
            ? <EmptyState title="No systems registered" hint="Add a system in Admin to enroll a PC." />
            : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="text-left text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--muted)" }}>
                      <th className="px-3 pb-2.5 font-semibold">System</th>
                      <th className="px-3 pb-2.5 font-semibold">Status</th>
                      <th className="px-3 pb-2.5 font-semibold">Last seen</th>
                      <th className="px-3 pb-2.5 text-right font-semibold">Tracked</th>
                      <th className="px-3 pb-2.5 text-right font-semibold">Sessions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(systems.data ?? []).map((sys, i) => (
                      <tr key={sys.system_id} className="text-[13px]" style={{ borderTop: "1px solid var(--border)" }}>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: systemColor(i) }} />
                            <span>
                              <span className="font-semibold">{sys.display_name}</span>
                              <br /><span className="text-[11px]" style={{ color: "var(--muted)" }}>{sys.hostname || "—"}</span>
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-3"><StatusPill status={sys.status} /></td>
                        <td className="tnum px-3 py-3" style={{ color: "var(--ink-2)" }}>{fmtRelative(sys.last_seen_at)}</td>
                        <td className="tnum px-3 py-3 text-right font-semibold">{fmtTokens(sys.total_tokens)}</td>
                        <td className="tnum px-3 py-3 text-right" style={{ color: "var(--ink-2)" }}>{sys.sessions}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </Card>
      </div>
    </div>
  );
}
