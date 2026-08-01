import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Sparkles } from "lucide-react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { RankingItem, Summary, SystemRow, Timeseries } from "../api/types";
import { RankingBars } from "../components/charts/RankingBars";
import { TimeseriesChart } from "../components/charts/TimeseriesChart";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHead,
  EmptyState,
  ErrorState,
  Eyebrow,
  LoadingState,
  StatusPill,
  Table,
  Td,
  Th,
} from "../components/ui";
import { fmtRelative, fmtTokens, systemColor } from "../lib/format";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
] as const;

const REFRESH_MS = 60_000;

export function Overview() {
  const [range, setRange] = useState<string>("7d");

  useEffect(() => {
    document.title = "Aurelia — Private operations";
  }, []);

  const summary = useQuery({
    queryKey: qk.summary,
    queryFn: () => api.get<Summary>("/dashboard/summary"),
    refetchInterval: REFRESH_MS,
  });
  const ranking = useQuery({
    queryKey: qk.ranking(range),
    queryFn: () => api.get<RankingItem[]>(`/dashboard/ranking?range=${range}`),
    refetchInterval: REFRESH_MS,
  });
  const ts = useQuery({
    queryKey: qk.timeseries(range),
    queryFn: () => api.get<Timeseries>(`/dashboard/timeseries?range=${range}`),
    refetchInterval: REFRESH_MS,
  });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
    refetchInterval: REFRESH_MS,
  });

  const s = summary.data;
  const noSystems = systems.isSuccess && systems.data.length === 0;
  const awaitingFirstSync =
    systems.isSuccess && systems.data.length > 0 && systems.data.every((x) => x.never_synced);

  const tiles = [
    { lbl: "Today", val: s ? fmtTokens(s.today_tokens) : "—", sub: "tracked tokens" },
    { lbl: "This week", val: s ? fmtTokens(s.week_tokens) : "—", sub: "last 7 days" },
    { lbl: "This month", val: s ? fmtTokens(s.month_tokens) : "—", sub: "month to date" },
    { lbl: "Total", val: s ? fmtTokens(s.total_tokens) : "—", sub: "all time" },
    {
      lbl: "Active PCs",
      val: s ? `${s.active_systems} / ${s.total_systems}` : "—",
      sub: "online now",
    },
    {
      lbl: "Highest consumer",
      val: s?.highest?.display_name ?? "—",
      sub: s?.highest ? `${fmtTokens(s.highest.total_tokens)} total` : "no data yet",
      accent: true,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <Card className="overflow-hidden border-accent/15 bg-[linear-gradient(135deg,rgba(255,255,255,0.95),rgba(244,242,238,0.95))] p-7">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <Eyebrow>Private operations</Eyebrow>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.02em] text-ink sm:text-4xl">
              Quiet intelligence for every connected workspace.
            </h1>
            <p className="mt-3 text-base text-ink-2">
              A calm, curated view of your fleet activity with the precision of a luxury suite and the clarity of a polished editorial dashboard.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link to="/connect">
                <Button>Connect a workstation</Button>
              </Link>
              <Link to="/sessions">
                <Button variant="ghost">Review sessions</Button>
              </Link>
            </div>
          </div>

          <div className="rounded-[18px] border border-line bg-surface/80 p-4 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              Current focus
            </div>
            <div className="mt-3 text-lg font-semibold text-ink">
              {s?.highest?.display_name ?? "Awaiting activity"}
            </div>
            <div className="mt-1 text-sm text-ink-2">
              {s?.highest ? `${fmtTokens(s.highest.total_tokens)} tracked` : "No data captured yet"}
            </div>
            <div className="mt-3 flex items-center gap-2 text-sm text-accent">
              <span className="font-medium">Live cadence</span>
              <ArrowUpRight className="h-4 w-4" />
            </div>
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-[-0.01em] text-ink">Observability overview</h2>
          <p className="text-sm text-ink-2">A composed view of the systems, growth, and attention they need.</p>
        </div>

        <div role="tablist" aria-label="Time range" className="inline-flex rounded-full border border-line bg-surface-2 p-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
                range === r.id ? "bg-surface text-ink shadow-[var(--shadow)]" : "text-ink-2 hover:text-ink"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <Alert tone="info">
        <b>Tracked activity, not billing.</b> Token counts come from local transcript files — an estimate, not your official Claude Max/Pro quota.
      </Alert>

      {noSystems && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-medium text-ink">No workstations connected yet</div>
            <div className="text-sm text-muted">Connect your first machine to start seeing usage here.</div>
          </div>
          <Link to="/connect">
            <Button>Connect a workstation</Button>
          </Link>
        </Card>
      )}

      {awaitingFirstSync && (
        <Alert tone="warn" title="Waiting for the first sync">
          Your workstation is connected but has not sent usage yet. Run the setup command on that machine, or wait for the next scheduled scan.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Card key={t.lbl} className="!p-4">
            <Eyebrow>{t.lbl}</Eyebrow>
            <div className={`mt-2 truncate font-semibold tracking-tight ${t.accent ? "text-lg text-accent" : "text-xl"}`} title={String(t.val)}>
              {summary.isLoading ? "…" : t.val}
            </div>
            <div className="mt-1 text-xs text-ink-2">{t.sub}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardHead title="Usage over time" hint="Tracked tokens per workstation" />
          {ts.isLoading ? (
            <LoadingState />
          ) : ts.isError ? (
            <ErrorState error={ts.error} onRetry={() => ts.refetch()} />
          ) : ts.data && ts.data.systems.length > 0 ? (
            <TimeseriesChart data={ts.data} />
          ) : (
            <EmptyState title="No usage yet" hint="Once a connected workstation syncs, its daily usage appears here." />
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardHead title="Current leader" hint="Highest consumer" />
            {summary.isLoading ? (
              <LoadingState />
            ) : summary.isError ? (
              <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
            ) : (
              <div className="space-y-4">
                <div className="rounded-[14px] border border-line bg-surface-2 p-4">
                  <div className="text-sm font-semibold text-ink">{s?.highest?.display_name ?? "No leader yet"}</div>
                  <div className="mt-1 text-sm text-ink-2">{s?.highest ? `${fmtTokens(s.highest.total_tokens)} total` : "Waiting for first sync"}</div>
                  <div className="mt-3">
                    <Badge tone="accent">Steady growth</Badge>
                  </div>
                </div>
                <div className="rounded-[14px] border border-line p-4">
                  <div className="text-sm font-semibold text-ink">Activity snapshot</div>
                  <div className="mt-3 grid gap-2 text-sm text-ink-2">
                    <div className="flex items-center justify-between">
                      <span>Connected workstations</span>
                      <span className="font-medium text-ink">{s?.total_systems ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Active now</span>
                      <span className="font-medium text-ink">{s?.active_systems ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>Tracked this month</span>
                      <span className="font-medium text-ink">{s ? fmtTokens(s.month_tokens) : "—"}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Card>

          <Card>
            <CardHead title="Ranking" hint={RANGES.find((r) => r.id === range)?.label} />
            {ranking.isLoading ? (
              <LoadingState />
            ) : ranking.isError ? (
              <ErrorState error={ranking.error} onRetry={() => ranking.refetch()} />
            ) : (
              <RankingBars items={ranking.data ?? []} scoped={s?.scoped ?? false} />
            )}
          </Card>
        </div>
      </div>

      <Card>
        <CardHead title="Workstations" hint="Status and activity" />
        {systems.isLoading ? (
          <LoadingState />
        ) : systems.isError ? (
          <ErrorState error={systems.error} onRetry={() => systems.refetch()} />
        ) : systems.data!.length === 0 ? (
          <EmptyState
            title="No workstations registered"
            hint="Connect a machine to start tracking its usage."
            action={
              <Link to="/connect">
                <Button size="sm">Connect a workstation</Button>
              </Link>
            }
          />
        ) : (
          <Table caption="Connected workstations with status and tracked usage">
            <thead>
              <tr>
                <Th>Workstation</Th>
                <Th>Status</Th>
                <Th>Last seen</Th>
                <Th align="right">Tracked</Th>
                <Th align="right">Sessions</Th>
              </tr>
            </thead>
            <tbody>
              {systems.data!.map((sys, i) => (
                <tr key={sys.system_id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: systemColor(i) }} aria-hidden />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-ink">{sys.display_name}</span>
                        <span className="block truncate text-xs text-muted">{sys.hostname || "—"}</span>
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <StatusPill status={sys.status} neverSynced={sys.never_synced} />
                  </Td>
                  <Td className="tnum text-ink-2">{fmtRelative(sys.last_seen_at)}</Td>
                  <Td align="right" className="tnum font-semibold text-ink">
                    {fmtTokens(sys.total_tokens)}
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {sys.sessions}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
