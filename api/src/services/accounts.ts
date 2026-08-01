/**
 * Shaping for the accounts dashboard.
 *
 * Two derivations happen here rather than in the repository, because both are
 * presentation rules that will change independently of storage: the plan label
 * (from raw Anthropic tier strings) and the health verdict (from Anthropic's
 * own severity, falling back to a percentage threshold).
 */

import { deriveHealth, derivePlan, type Health, type PlanFamily } from "../core/plans.js";
import { listAccounts, type AccountListRow } from "../repositories/accounts.js";
import type { Allowed } from "../repositories/scope.js";

/** The window an admin actually cares about when asking "is this account loaded?" */
const PRIMARY_KIND = "weekly_all";
const SESSION_KIND = "session";

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
  /** When Claude Code last refreshed these figures — they can be stale. */
  utilization_fetched_at: string | null;
  systems: AccountListRow["systems"];
  users: AccountListRow["users"];
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

  return rows.map((row) => {
    const plan = derivePlan(row.organization_type, row.rate_limit_tier);
    const weekly = row.limits.find((l) => l.kind === PRIMARY_KIND);
    const session = row.limits.find((l) => l.kind === SESSION_KIND);

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
      utilization_fetched_at: fetchedAt ?? null,
      systems: row.systems,
      users: row.users,
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
