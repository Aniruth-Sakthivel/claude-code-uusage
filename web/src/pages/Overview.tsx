/**
 * Dashboard overview — the headline "which PC uses the most" view.
 *
 * Fixes over the previous version: every query now renders a distinct error
 * state (failures used to look identical to "no data"), the tile grid is
 * responsive rather than a fixed 6-column layout, the range switcher is a real
 * tablist, and data refreshes on an interval — a fleet monitor that never
 * updated itself was arguably the biggest gap.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { RankingItem, Summary, SystemRow, Timeseries } from "../api/types";
import { RankingBars } from "../components/charts/RankingBars";
import { TimeseriesChart } from "../components/charts/TimeseriesChart";
import {
  Alert,
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

/** Keep the fleet view live without hammering the API. */
const REFRESH_MS = 60_000;

export function Overview() {
  const [range, setRange] = useState<string>("7d");

  useEffect(() => {
    document.title = "Dashboard — ClaudeFleet";
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Which PC is using the most?
          </h1>
          <p className="text-base text-ink-2">
            Tracked Claude Code token activity across your machines.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Time range"
          className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5"
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-semibold transition ${
                range === r.id
                  ? "bg-surface text-ink shadow-[var(--shadow)]"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <Alert tone="info">
        <b>Tracked activity, not billing.</b> Token counts come from local transcript
        files — an estimate, not your official Claude Max/Pro quota.
      </Alert>

      {noSystems && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-medium">No PCs connected yet</div>
            <div className="text-sm text-muted">
              Connect your first machine to start seeing usage here.
            </div>
          </div>
          <Link to="/connect">
            <Button>Connect a PC</Button>
          </Link>
        </Card>
      )}

      {awaitingFirstSync && (
        <Alert tone="warn" title="Waiting for the first sync">
          Your PC is connected but has not sent usage yet. Run the setup command on that
          machine, or wait for the next scheduled scan.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <Card key={t.lbl} className="!p-4">
            <Eyebrow>{t.lbl}</Eyebrow>
            <div
              className={`mt-2 truncate font-semibold tracking-tight ${
                t.accent ? "text-lg text-accent" : "text-xl"
              }`}
              title={String(t.val)}
            >
              {summary.isLoading ? "…" : t.val}
            </div>
            <div className="mt-0.5 text-xs text-ink-2">{t.sub}</div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHead
          title="Ranking"
          hint={RANGES.find((r) => r.id === range)?.label}
        />
        {ranking.isLoading ? (
          <LoadingState />
        ) : ranking.isError ? (
          <ErrorState error={ranking.error} onRetry={() => ranking.refetch()} />
        ) : (
          <RankingBars items={ranking.data ?? []} scoped={s?.scoped ?? false} />
        )}
      </Card>

      <Card>
        <CardHead title="Usage over time" hint="Tracked tokens per PC" />
        {ts.isLoading ? (
          <LoadingState />
        ) : ts.isError ? (
          <ErrorState error={ts.error} onRetry={() => ts.refetch()} />
        ) : ts.data && ts.data.systems.length > 0 ? (
          <TimeseriesChart data={ts.data} />
        ) : (
          <EmptyState
            title="No usage yet"
            hint="Once a connected PC syncs, its daily usage appears here."
          />
        )}
      </Card>

      <Card>
        <CardHead title="PCs" hint="Status and activity" />
        {systems.isLoading ? (
          <LoadingState />
        ) : systems.isError ? (
          <ErrorState error={systems.error} onRetry={() => systems.refetch()} />
        ) : systems.data!.length === 0 ? (
          <EmptyState
            title="No PCs registered"
            hint="Connect a machine to start tracking its usage."
            action={
              <Link to="/connect">
                <Button size="sm">Connect a PC</Button>
              </Link>
            }
          />
        ) : (
          <Table caption="Connected PCs with status and tracked usage">
            <thead>
              <tr>
                <Th>PC</Th>
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
                      <span
                        className="h-2.5 w-2.5 flex-none rounded-[3px]"
                        style={{ background: systemColor(i) }}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">
                          {sys.display_name}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {sys.hostname || "—"}
                        </span>
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <StatusPill status={sys.status} neverSynced={sys.never_synced} />
                  </Td>
                  <Td className="tnum text-ink-2">{fmtRelative(sys.last_seen_at)}</Td>
                  <Td align="right" className="tnum font-semibold">
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
