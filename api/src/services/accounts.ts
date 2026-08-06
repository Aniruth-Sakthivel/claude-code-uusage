/**
 * Shaping for the accounts dashboard.
 *
 * Two derivations happen here rather than in the repository, because both are
 * presentation rules that will change independently of storage: the plan label
 * (from raw Anthropic tier strings) and the health verdict (from Anthropic's
 * own severity, falling back to a percentage threshold).
 */

import { deriveBillingDates, type BillingDates } from "../core/billing.js";
import { deriveHealth, derivePlan, type Health, type PlanFamily } from "../core/plans.js";
import { listAccounts, type AccountListRow } from "../repositories/accounts.js";
import type { Allowed } from "../repositories/scope.js";

/** The window an admin actually cares about when asking "is this account loaded?" */
const PRIMARY_KIND = "weekly_all";
const SESSION_KIND = "session";

type Reading = AccountListRow["limits"][number];

/**
 * A cached reading is only true until its own window rolls over.
 *
 * These figures are whatever Claude Code last wrote to `~/.claude.json`, and it
 * only rewrites that cache when it talks to Anthropic. On a machine nobody is
 * driving, the agent keeps re-posting the same reading every minute and the
 * dedup index correctly drops it — so the last value before the window reset
 * stays on screen indefinitely. Observed in production: a 5-hour window read at
 * 60% with `resets_at` of 08:49 was still being served at 10:11, long after it
 * had actually gone back to zero.
 *
 * `resets_at` is the one thing in the reading that stays meaningful as it ages:
 * once it is in the past, the window provably restarted and the percentage that
 * came with it describes a window that no longer exists. What the new window
 * stands at is unknown until the next reading — reporting zero would be just as
 * invented as leaving 60% up — so the reading is dropped and the UI says it is
 * waiting rather than showing a number nobody should act on.
 */
function stillValid(limit: Reading | undefined, now: number): Reading | null {
  if (!limit) return null;
  if (!limit.resets_at) return limit; // no window boundary to expire against
  const resetsAt = Date.parse(limit.resets_at);
  if (!Number.isFinite(resetsAt)) return limit;
  return resetsAt > now ? limit : null;
}

export interface AccountView {
  id: number;
  account_uuid: string;
  email_address: string;
  display_name: string;
  organization_name: string;
  plan_label: string;
  plan_family: PlanFamily;
  has_extra_usage_enabled: boolean;
  status: "online" | "idle" | "offline";
  health: Health;
  /** Weekly window — the headline number. */
  weekly_percent: number | null;
  weekly_resets_at: string | null;
  /** Rolling 5-hour window. */
  session_percent: number | null;
  session_resets_at: string | null;
  /**
   * A reading arrived, but its window has since reset and no fresher one has
   * come in — so the percentage is `null` because it is unknown, not because
   * the account was never measured. The UI distinguishes the two.
   */
  weekly_expired: boolean;
  session_expired: boolean;
  /** When Claude Code last refreshed these figures — they can be stale. */
  utilization_fetched_at: string | null;
  systems: AccountListRow["systems"];
  /**
   * Everyone on the subscription, heaviest first, each carrying `share_percent`
   * — their portion of the week's tokens across the people on this account.
   * That comparison is the point of the page: on a shared plan, the question is
   * always which person is consuming it.
   */
  users: (AccountListRow["users"][number] & { share_percent: number })[];
  unassigned_systems: AccountListRow["unassigned_systems"];
  /** True when more than one person works on this subscription. */
  is_shared: boolean;
  /** The person with the most usage this week, when there is more than one. */
  top_user: { id: number; name: string; tokens_week: number; share_percent: number } | null;
  billing: BillingDates;
  seat_tier: string;
  tokens_today: number;
  tokens_week: number;
  last_seen_at: string | null;
}

/**
 * An account is "idle" when it is bound to machines but none are online — a
 * distinct state from "offline" (no bound machines at all), because an idle
 * subscription is the one an admin might reassign.
 */
function statusOf(row: AccountListRow): "online" | "idle" | "offline" {
  if (row.systems.length === 0) return "offline";
  return row.systems.some((s) => s.status === "online") ? "online" : "idle";
}

export async function buildAccountList(
  allowed: Allowed,
  todayUtc: string,
  weekStartUtc: string,
): Promise<AccountView[]> {
  const rows = await listAccounts(allowed, todayUtc, weekStartUtc);
  const now = Date.now();

  return rows.map((row) => {
    const plan = derivePlan(row.organization_type, row.rate_limit_tier);
    const weeklyRead = row.limits.find((l) => l.kind === PRIMARY_KIND);
    const sessionRead = row.limits.find((l) => l.kind === SESSION_KIND);
    const weekly = stillValid(weeklyRead, now);
    const session = stillValid(sessionRead, now);

    // Health follows the worst of the two windows, so a nearly-exhausted
    // 5-hour window is not hidden by a comfortable weekly figure.
    const verdicts = [weekly, session]
      .filter((l): l is NonNullable<typeof l> => Boolean(l))
      .map((l) => deriveHealth(l.severity, l.percent));
    const rank: Health[] = ["healthy", "moderate", "heavy"];
    const health: Health = verdicts.length
      ? verdicts.reduce((worst, v) => (rank.indexOf(v) > rank.indexOf(worst) ? v : worst))
      : "unknown";

    const fetchedAt = row.limits
      .map((l) => l.fetched_at)
      .sort()
      .at(-1);

    /**
     * Each person's share of the week, measured against the people on this
     * account rather than the account total. Those two differ when a machine
     * is assigned to more than one person (it counts for each) or belongs to
     * nobody — and a bar chart whose segments do not reach 100% reads as a
     * bug. Comparing people against each other is also the actual question:
     * who is using this subscription most.
     */
    const peopleTotal = row.users.reduce((sum, u) => sum + u.tokens_week, 0);
    const usersWithShare = row.users.map((u) => ({
      ...u,
      share_percent: peopleTotal > 0 ? Math.round((u.tokens_week / peopleTotal) * 1000) / 10 : 0,
    }));
    const heaviest = usersWithShare[0]; // repository already sorts heaviest first
    const topUser =
      heaviest && usersWithShare.length > 1
        ? {
            id: heaviest.id,
            name: heaviest.full_name || heaviest.email,
            tokens_week: heaviest.tokens_week,
            share_percent: heaviest.share_percent,
          }
        : null;

    return {
      id: row.id,
      account_uuid: row.account_uuid,
      email_address: row.email_address,
      display_name: row.display_name,
      organization_name: row.organization_name,
      plan_label: plan.label,
      plan_family: plan.family,
      has_extra_usage_enabled: row.has_extra_usage_enabled,
      status: statusOf(row),
      health,
      weekly_percent: weekly?.percent ?? null,
      weekly_resets_at: weekly?.resets_at ?? null,
      session_percent: session?.percent ?? null,
      session_resets_at: session?.resets_at ?? null,
      weekly_expired: Boolean(weeklyRead) && weekly === null,
      session_expired: Boolean(sessionRead) && session === null,
      utilization_fetched_at: fetchedAt ?? null,
      systems: row.systems,
      users: usersWithShare,
      unassigned_systems: row.unassigned_systems,
      is_shared: row.is_shared,
      top_user: topUser,
      billing: deriveBillingDates(row.subscription_created_at, row.trial_ends_at),
      seat_tier: row.seat_tier,
      tokens_today: row.tokens_today,
      tokens_week: row.tokens_week,
      last_seen_at: row.last_seen_at,
    };
  });
}

export interface AccountSummary {
  total_accounts: number;
  by_family: Record<string, number>;
  in_use: number;
  idle: number;
  heaviest: { account_uuid: string; email_address: string; percent: number } | null;
}

export function summarizeAccounts(accounts: AccountView[]): AccountSummary {
  const byFamily: Record<string, number> = {};
  for (const a of accounts) byFamily[a.plan_family] = (byFamily[a.plan_family] ?? 0) + 1;

  const withPercent = accounts.filter((a) => a.weekly_percent !== null);
  const heaviest = withPercent.length
    ? withPercent.reduce((max, a) => ((a.weekly_percent ?? 0) > (max.weekly_percent ?? 0) ? a : max))
    : null;

  return {
    total_accounts: accounts.length,
    by_family: byFamily,
    in_use: accounts.filter((a) => a.status === "online").length,
    idle: accounts.filter((a) => a.status === "idle").length,
    heaviest: heaviest
      ? {
          account_uuid: heaviest.account_uuid,
          email_address: heaviest.email_address,
          percent: heaviest.weekly_percent ?? 0,
        }
      : null,
  };
}
