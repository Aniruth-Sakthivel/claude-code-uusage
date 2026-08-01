/**
 * Claude subscription accounts — who is on which plan, and how loaded it is.
 *
 * The headline figures here come from Claude Code's own rate-limit data, so
 * unlike the token counts elsewhere in this app they are exact rather than an
 * estimate. They are also *cached* by Claude Code, so the page always shows
 * when they were last refreshed rather than implying they are live.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { AccountRow, AccountsResponse } from "../api/types";
import {
  Alert,
  Badge,
  Card,
  CardHead,
  EmptyState,
  ErrorState,
  Eyebrow,
  Input,
  LoadingState,
  Pagination,
  Table,
  Td,
  Th,
} from "../components/ui";
import { UtilizationMeter } from "../components/charts/UtilizationMeter";
import { fmtRelative, fmtResetsIn, fmtTokens } from "../lib/format";
import { useTableControls } from "../lib/useTableControls";

const REFRESH_MS = 60_000;

const STATUS_TONE: Record<AccountRow["status"], string> = {
  online: "text-good",
  idle: "text-warn",
  offline: "text-muted",
};

const STATUS_LABEL: Record<AccountRow["status"], string> = {
  online: "In use",
  idle: "Idle",
  offline: "No PC bound",
};

function PlanBadge({ label, family }: { label: string; family: string }) {
  // Only Max gets the accent — everything else stays neutral so the badge
  // column doesn't turn into a colour chart.
  return <Badge tone={family === "max" ? "accent" : "neutral"}>{label}</Badge>;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="faceplate text-2xs text-muted">{label}</div>
      <div className="tnum mt-1 text-xl font-semibold text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

export function Accounts() {
  useEffect(() => {
    document.title = "Accounts — Meterhouse";
  }, []);

  const q = useQuery({
    queryKey: qk.accounts,
    queryFn: () => api.get<AccountsResponse>("/accounts"),
    refetchInterval: REFRESH_MS,
  });

  const accounts = q.data?.accounts ?? [];

  const table = useTableControls(accounts, {
    searchText: (a) =>
      `${a.email_address} ${a.display_name} ${a.organization_name} ${a.plan_label} ` +
      a.users.map((u) => `${u.email} ${u.full_name}`).join(" ") +
      a.systems.map((s) => s.display_name).join(" "),
    sorters: {
      account: (a, b) => a.email_address.localeCompare(b.email_address),
      plan: (a, b) => a.plan_label.localeCompare(b.plan_label),
      users: (a, b) => a.users.length - b.users.length,
      weekly: (a, b) => (a.weekly_percent ?? -1) - (b.weekly_percent ?? -1),
      session: (a, b) => (a.session_percent ?? -1) - (b.session_percent ?? -1),
      tokens: (a, b) => a.tokens_week - b.tokens_week,
    },
    descFirst: ["users", "weekly", "session", "tokens"],
    // Heaviest first: the account about to run out is the one worth seeing.
    initialSortKey: "weekly",
    initialSortDir: "desc",
  });

  const summary = q.data?.summary;
  // Most recent reading across all accounts — shown so a stale figure is
  // visibly stale rather than passing as live.
  const fetchedTimes = accounts
    .map((a) => a.utilization_fetched_at)
    .filter((t): t is string => Boolean(t))
    .sort();
  const staleAt = fetchedTimes[fetchedTimes.length - 1];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Subscriptions</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Claude accounts</h1>
        <p className="mt-1.5 text-base text-muted">
          Which account each person is signed into, and how much of its rate limit is gone.
        </p>
      </div>

      {q.isLoading ? (
        <Card>
          <LoadingState />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : accounts.length === 0 ? (
        <Card>
          <EmptyState
            title="No Claude accounts reported yet"
            hint={
              <>
                Account reporting is off by default. On each PC, run{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5">meterhouse account show</code> to
                see exactly what would be sent, then{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5">meterhouse account enable</code>.
              </>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Tile label="Accounts" value={String(summary?.total_accounts ?? 0)} />
            <Tile
              label="Max"
              value={String(summary?.by_family?.max ?? 0)}
              sub={`${summary?.by_family?.pro ?? 0} Pro`}
            />
            <Tile label="In use" value={String(summary?.in_use ?? 0)} sub="a PC is live" />
            <Tile label="Idle" value={String(summary?.idle ?? 0)} sub="bound but quiet" />
            <Tile
              label="Heaviest"
              value={summary?.heaviest ? `${Math.round(summary.heaviest.percent)}%` : "—"}
              sub={summary?.heaviest?.email_address ?? "no readings yet"}
            />
          </div>

          {q.data?.scoped && (
            <Alert tone="info">
              Showing only accounts used by the PCs assigned to you. Figures cover your machines,
              not the whole fleet.
            </Alert>
          )}

          <Card>
            <CardHead
              title="Accounts"
              hint={staleAt ? `rate limits read ${fmtRelative(staleAt)}` : undefined}
            />
            <div className="mb-3">
              <Input
                type="search"
                placeholder="Search by account, person, org, or PC…"
                value={table.query}
                onChange={(e) => table.setQuery(e.target.value)}
                aria-label="Search accounts"
              />
            </div>

            {table.total === 0 ? (
              <EmptyState title="No accounts match your search" />
            ) : (
              <Table caption="Claude accounts with plan, assigned people, and rate-limit use">
                <thead>
                  <tr>
                    <Th
                      sortDir={table.sortKey === "account" ? table.sortDir : null}
                      onSort={() => table.toggleSort("account")}
                    >
                      Account
                    </Th>
                    <Th
                      sortDir={table.sortKey === "plan" ? table.sortDir : null}
                      onSort={() => table.toggleSort("plan")}
                    >
                      Plan
                    </Th>
                    <Th
                      sortDir={table.sortKey === "users" ? table.sortDir : null}
                      onSort={() => table.toggleSort("users")}
                    >
                      People
                    </Th>
                    <Th>Status</Th>
                    <Th
                      sortDir={table.sortKey === "weekly" ? table.sortDir : null}
                      onSort={() => table.toggleSort("weekly")}
                    >
                      Weekly limit
                    </Th>
                    <Th
                      sortDir={table.sortKey === "session" ? table.sortDir : null}
                      onSort={() => table.toggleSort("session")}
                    >
                      5-hour limit
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "tokens" ? table.sortDir : null}
                      onSort={() => table.toggleSort("tokens")}
                    >
                      Tokens (7d)
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((a) => (
                    <tr key={a.account_uuid}>
                      <Td>
                        <div className="font-semibold">{a.email_address || a.display_name}</div>
                        <div className="text-xs text-muted">{a.organization_name || "—"}</div>
                      </Td>
                      <Td>
                        <PlanBadge label={a.plan_label} family={a.plan_family} />
                      </Td>
                      <Td>
                        {a.users.length === 0 ? (
                          <span className="text-muted">unassigned</span>
                        ) : (
                          <div className="text-ink-2">
                            {a.users.map((u) => u.full_name || u.email).join(", ")}
                          </div>
                        )}
                        <div className="text-xs text-muted">
                          {a.systems.length} PC{a.systems.length === 1 ? "" : "s"}
                        </div>
                      </Td>
                      <Td>
                        <span className={`text-sm font-semibold ${STATUS_TONE[a.status]}`}>
                          {STATUS_LABEL[a.status]}
                        </span>
                      </Td>
                      <Td>
                        <UtilizationMeter
                          percent={a.weekly_percent}
                          health={a.health}
                          compact
                        />
                        <div className="tnum text-2xs text-muted">
                          {a.weekly_resets_at ? `resets ${fmtResetsIn(a.weekly_resets_at)}` : "—"}
                        </div>
                      </Td>
                      <Td>
                        <UtilizationMeter percent={a.session_percent} health={a.health} compact />
                        <div className="tnum text-2xs text-muted">
                          {a.session_resets_at ? `resets ${fmtResetsIn(a.session_resets_at)}` : "—"}
                        </div>
                      </Td>
                      {/* Summed over the PCs currently bound to this account —
                          approximate if someone switched plans mid-week. */}
                      <Td align="right" className="tnum font-semibold">
                        {fmtTokens(a.tokens_week)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}

            <Pagination
              page={table.page}
              pageCount={table.pageCount}
              total={table.total}
              pageSize={table.pageSize}
              onPage={table.setPage}
            />
          </Card>
        </>
      )}
    </div>
  );
}
