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
} from "../components/ui";
import { UtilizationMeter } from "../components/charts/UtilizationMeter";
import { fmtDate, fmtRelative, fmtResetsIn, fmtTokens } from "../lib/format";
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

/** Renewal / trial line. Never states an amount — only a date to expect one. */
function BillingLine({ billing }: { billing: AccountRow["billing"] }) {
  if (!billing) return <span className="text-muted">—</span>;

  if (billing.trial_ends_at) {
    return (
      <span>
        Trial ends <span className="font-semibold">{fmtDate(billing.trial_ends_at)}</span>
        {billing.days_until !== null && (
          <span className="text-muted"> · in {billing.days_until}d</span>
        )}
      </span>
    );
  }
  if (billing.next_renewal_at) {
    return (
      <span>
        Renews <span className="font-semibold">{fmtDate(billing.next_renewal_at)}</span>
        {billing.days_until !== null && (
          <span className="text-muted"> · in {billing.days_until}d</span>
        )}
        {/* Anthropic publishes no invoice date; this is the subscription's
            monthly anniversary, so say so rather than implying it is billed. */}
        <span className="text-muted"> (est.)</span>
      </span>
    );
  }
  return <span className="text-muted">Renewal date unknown</span>;
}

/**
 * Who is consuming this subscription.
 *
 * The whole reason to look at a shared account is to find out which person is
 * eating it, so the people are ranked and given a proportional bar — a list of
 * names and raw token counts makes the reader do that comparison in their head.
 *
 * The bars are shares *among these people*, not of the account total: a machine
 * assigned to two people counts for each, and unowned machines belong to no
 * one, so shares of the account total would not add up to 100% and would read
 * as a rendering bug.
 */
function UsageBreakdown({ account }: { account: AccountRow }) {
  const unowned = account.unassigned_systems ?? [];

  if (account.users.length === 0) {
    return (
      <div className="text-sm text-muted">
        {unowned.length > 0
          ? `${unowned.length} machine${unowned.length === 1 ? "" : "s"} bound, but assigned to nobody — assign an owner to see usage per person.`
          : "No machines bound to this account yet."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {account.users.map((u, i) => (
        <div key={u.id}>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{u.full_name || u.email}</span>
              {i === 0 && account.is_shared && <Badge tone="accent">Heaviest</Badge>}
            </div>
            <div className="tnum text-xs text-muted">
              <span className="font-semibold text-ink-2">{fmtTokens(u.tokens_week)}</span> this
              week · {fmtTokens(u.tokens_today)} today
              {account.is_shared && <> · {u.share_percent}%</>}
            </div>
          </div>

          {account.is_shared && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
              role="img"
              aria-label={`${u.full_name || u.email}: ${u.share_percent}% of this account's usage`}
            >
              <div
                className={`h-full rounded-full ${i === 0 ? "bg-accent" : "bg-ink-2/40"}`}
                style={{ width: `${Math.max(u.share_percent, 1)}%` }}
              />
            </div>
          )}

          <div className="mt-0.5 text-2xs text-muted">
            {u.systems.length > 0
              ? u.systems.map((s) => s.display_name).join(", ")
              : "no machines"}
          </div>
        </div>
      ))}

      {unowned.length > 0 && (
        <div className="border-t border-line pt-2 text-2xs text-muted">
          Not counted above: {unowned.map((s) => s.display_name).join(", ")} — bound to this
          account with no owner on record.
        </div>
      )}
    </div>
  );
}

/** One subscription: what it is, how loaded it is, and who is using it. */
function AccountCard({ account: a }: { account: AccountRow }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{a.email_address || a.display_name}</span>
            <PlanBadge label={a.plan_label} family={a.plan_family} />
            <span className={`text-xs font-semibold ${STATUS_TONE[a.status]}`}>
              {STATUS_LABEL[a.status]}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {a.organization_name || "—"}
            {a.seat_tier && <> · seat {a.seat_tier}</>}
          </div>
        </div>

        <div className="text-right text-xs">
          <div className="text-muted">Next payment</div>
          <div className="text-ink-2">
            <BillingLine billing={a.billing} />
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-muted">Weekly limit</span>
              <span className="tnum text-2xs text-muted">
                {a.weekly_resets_at ? `resets ${fmtResetsIn(a.weekly_resets_at)}` : "—"}
              </span>
            </div>
            <UtilizationMeter percent={a.weekly_percent} health={a.health} compact />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-muted">5-hour limit</span>
              <span className="tnum text-2xs text-muted">
                {a.session_resets_at ? `resets ${fmtResetsIn(a.session_resets_at)}` : "—"}
              </span>
            </div>
            <UtilizationMeter percent={a.session_percent} health={a.health} compact />
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-line pt-3">
            <div>
              <div className="text-2xs text-muted">Tokens today</div>
              <div className="tnum text-lg font-semibold">{fmtTokens(a.tokens_today)}</div>
            </div>
            <div>
              <div className="text-2xs text-muted">Tokens this week</div>
              <div className="tnum text-lg font-semibold">{fmtTokens(a.tokens_week)}</div>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">
              {a.is_shared ? "Who is using it most" : "Who is using it"}
            </span>
            {a.is_shared && <Badge tone="neutral">{a.users.length} people</Badge>}
          </div>
          <UsageBreakdown account={a} />
        </div>
      </div>
    </Card>
  );
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
              /* Enabling reporting on its own changes nothing here — a report
                 has to be pushed before this page can fill in. Leaving that
                 step out is what makes the page look broken to someone who has
                 already run `account enable`. */
              <>
                Account reporting is off by default. On each PC, run{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5">
                  python -m meterhouse account show
                </code>{" "}
                to see exactly what would be sent, then{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5">
                  python -m meterhouse account enable
                </code>
                . Enabling alone sends nothing — the report goes out with the next{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5">
                  python -m meterhouse sync
                </code>{" "}
                (or from{" "}
                <code className="rounded bg-surface-2 px-1 py-0.5">
                  python -m meterhouse daemon
                </code>
                , which is the only way on agent 0.1.2 and older).
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
              <div className="flex flex-col gap-4">
                {table.rows.map((a) => (
                  <AccountCard key={a.account_uuid} account={a} />
                ))}
              </div>
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
