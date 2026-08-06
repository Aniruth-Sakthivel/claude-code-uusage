/**
 * Claude subscription accounts — reads and the agent-facing write path.
 *
 * The write path's one subtle job is keeping `system_account_bindings`
 * honest: a machine has at most one open binding, and a change of account
 * closes the old interval rather than overwriting it. History is what lets
 * "which account used the most last month" stay true after someone switches
 * plans.
 */

import { and, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import {
  accountUsageSnapshots,
  claudeAccounts,
  dailyAggregates,
  roles,
  systemAccountBindings,
  systems,
  userSystems,
  users,
} from "../db/schema.js";
import { ADMIN, MANAGER } from "../core/rbac.js";
import { isOnline } from "../core/time.js";
import { scopeSystems, type Allowed } from "./scope.js";

export interface AccountIdentityInput {
  account_uuid: string;
  email_address: string;
  display_name: string;
  organization_name: string;
  organization_uuid: string;
  organization_type: string;
  rate_limit_tier: string;
  organization_role: string;
  billing_type: string;
  has_extra_usage_enabled: boolean;
  /** Billing timeline; empty string when an older agent did not report it. */
  account_created_at: string;
  subscription_created_at: string;
  trial_ends_at: string;
  seat_tier: string;
  user_rate_limit_tier: string;
}

export interface LimitInput {
  kind: string;
  grp: string;
  scope_label: string;
  percent: number;
  severity: string;
  is_active: boolean;
  resets_at: string;
}

export interface DollarsInput {
  limit_dollars?: number;
  used_dollars?: number;
  remaining_dollars?: number;
}

/** A timestamp string that may be empty or unparseable — never throw on it. */
function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Record an agent's account report.
 *
 * Returns whether this was a switch, so the caller can write the audit entry.
 * Everything happens in one transaction: a half-applied switch would leave two
 * open bindings and corrupt attribution.
 */
export async function recordAccountReport(input: {
  systemId: string;
  identity: AccountIdentityInput;
  fetchedAtMs: number;
  limits: LimitInput[];
  dollars: Record<string, DollarsInput>;
}): Promise<{
  accountId: number;
  switchedFrom: string | null;
  /** Reading per limit kind as it stood *before* this report, for alerting. */
  previousPercents: Map<string, number>;
}> {
  const previousPercents = new Map<string, number>();

  return db.transaction(async (tx) => {
    const now = new Date();
    const id = input.identity;

    // 1. Upsert the account. Identity fields are refreshed every report so a
    //    renamed org or an upgraded plan is picked up without manual work.
    const [account] = await tx
      .insert(claudeAccounts)
      .values({
        accountUuid: id.account_uuid,
        emailAddress: id.email_address,
        displayName: id.display_name,
        organizationName: id.organization_name,
        organizationUuid: id.organization_uuid,
        organizationType: id.organization_type,
        rateLimitTier: id.rate_limit_tier,
        organizationRole: id.organization_role,
        billingType: id.billing_type,
        hasExtraUsageEnabled: id.has_extra_usage_enabled,
        accountCreatedAt: id.account_created_at,
        subscriptionCreatedAt: id.subscription_created_at,
        trialEndsAt: id.trial_ends_at,
        seatTier: id.seat_tier,
        userRateLimitTier: id.user_rate_limit_tier,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: claudeAccounts.accountUuid,
        set: {
          emailAddress: id.email_address,
          displayName: id.display_name,
          organizationName: id.organization_name,
          organizationUuid: id.organization_uuid,
          organizationType: id.organization_type,
          rateLimitTier: id.rate_limit_tier,
          organizationRole: id.organization_role,
          billingType: id.billing_type,
          hasExtraUsageEnabled: id.has_extra_usage_enabled,
          // An agent too old to report these sends "", which must not wipe a
          // value an up-to-date agent already supplied for the same account.
          accountCreatedAt: sql`coalesce(nullif(${id.account_created_at}, ''), ${claudeAccounts.accountCreatedAt})`,
          subscriptionCreatedAt: sql`coalesce(nullif(${id.subscription_created_at}, ''), ${claudeAccounts.subscriptionCreatedAt})`,
          trialEndsAt: sql`coalesce(nullif(${id.trial_ends_at}, ''), ${claudeAccounts.trialEndsAt})`,
          seatTier: sql`coalesce(nullif(${id.seat_tier}, ''), ${claudeAccounts.seatTier})`,
          userRateLimitTier: sql`coalesce(nullif(${id.user_rate_limit_tier}, ''), ${claudeAccounts.userRateLimitTier})`,
          lastSeenAt: now,
        },
      })
      .returning({ id: claudeAccounts.id });

    // The upsert always returns a row; this narrows the type rather than
    // guarding a case that can happen.
    if (!account) throw new Error("account upsert returned no row");

    // 2. Reconcile the binding interval for this machine.
    const [open] = await tx
      .select({ id: systemAccountBindings.id, accountId: systemAccountBindings.accountId })
      .from(systemAccountBindings)
      .where(
        and(
          eq(systemAccountBindings.systemId, input.systemId),
          isNull(systemAccountBindings.validTo),
        ),
      )
      .limit(1);

    let switchedFrom: string | null = null;
    if (!open) {
      await tx
        .insert(systemAccountBindings)
        .values({ systemId: input.systemId, accountId: account.id, validFrom: now });
    } else if (open.accountId !== account.id) {
      // A real switch: close the old interval at the same instant the new one
      // opens, so the history has no gap and no overlap.
      const [previous] = await tx
        .select({ uuid: claudeAccounts.accountUuid })
        .from(claudeAccounts)
        .where(eq(claudeAccounts.id, open.accountId))
        .limit(1);
      switchedFrom = previous?.uuid ?? null;

      await tx
        .update(systemAccountBindings)
        .set({ validTo: now })
        .where(eq(systemAccountBindings.id, open.id));
      await tx
        .insert(systemAccountBindings)
        .values({ systemId: input.systemId, accountId: account.id, validFrom: now });
    }

    // Capture the previous reading per kind BEFORE appending the new one —
    // limit alerting fires on an upward crossing, so it needs the value this
    // report is about to supersede. Read inside the same transaction so a
    // concurrent report cannot slip between the read and the insert.
    const priorRows = await tx
      .selectDistinctOn([accountUsageSnapshots.kind], {
        kind: accountUsageSnapshots.kind,
        percent: accountUsageSnapshots.percent,
      })
      .from(accountUsageSnapshots)
      .where(eq(accountUsageSnapshots.accountId, account.id))
      .orderBy(accountUsageSnapshots.kind, desc(accountUsageSnapshots.fetchedAt));
    for (const row of priorRows) {
      const value = Number(row.percent);
      if (Number.isFinite(value)) previousPercents.set(row.kind, value);
    }

    // 3. Append the rate-limit readings. Deduped on (account, kind, fetchedAt)
    //    so re-reporting an unchanged cached value is a no-op.
    const fetchedAt = new Date(input.fetchedAtMs || now.getTime());
    if (input.limits.length > 0) {
      await tx
        .insert(accountUsageSnapshots)
        .values(
          input.limits.map((limit) => {
            // Dollar figures are keyed by window name, not by limit kind.
            const windowKey = limit.kind === "session" ? "five_hour" : "seven_day";
            const money = input.dollars[windowKey] ?? {};
            return {
              accountId: account.id,
              systemId: input.systemId,
              kind: limit.kind,
              grp: limit.grp,
              scopeLabel: limit.scope_label,
              percent: String(limit.percent),
              severity: limit.severity,
              isActive: limit.is_active,
              resetsAt: parseDate(limit.resets_at),
              limitDollars: money.limit_dollars === undefined ? null : String(money.limit_dollars),
              usedDollars: money.used_dollars === undefined ? null : String(money.used_dollars),
              remainingDollars:
                money.remaining_dollars === undefined ? null : String(money.remaining_dollars),
              fetchedAt,
            };
          }),
        )
        .onConflictDoNothing();
    }

    return { accountId: account.id, switchedFrom, previousPercents };
  });
}

/**
 * Remove Claude accounts nothing refers to any more.
 *
 * `system_account_bindings` is the only edge from an account back to the fleet:
 * a deleted machine cascades its bindings away, and a person reaches an account
 * only through the machines assigned to them. So an account with no binding left
 * has neither a machine nor a person on it — and because there is no delete
 * endpoint for an account, it would otherwise sit on the accounts page forever.
 *
 * An account whose machines are still bound but unowned is deliberately kept.
 * That machine is still reporting, so the subscription is still real; the page
 * already shows it under "unassigned", and deleting it would only invite the
 * next agent report to recreate it a minute later, minus its history.
 *
 * Cascades to `system_account_bindings` and `account_usage_snapshots`. Takes a
 * connection so it can run inside the same transaction as the delete that
 * orphaned the account.
 */
export async function deleteOrphanedAccounts(conn: DbLike = db): Promise<string[]> {
  const removed = await conn
    .delete(claudeAccounts)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(systemAccountBindings)
          .where(eq(systemAccountBindings.accountId, claudeAccounts.id)),
      ),
    )
    .returning({ uuid: claudeAccounts.accountUuid, email: claudeAccounts.emailAddress });

  return removed.map((r) => r.email || r.uuid);
}

/**
 * Who should hear about this account's limits.
 *
 * The people whose machines are on it, plus every admin and manager — those
 * roles see the whole fleet, so an account nobody is assigned to still reaches
 * someone who can act on it.
 */
export async function alertRecipients(accountId: number): Promise<number[]> {
  const assigned = await db
    .selectDistinct({ userId: userSystems.userId })
    .from(systemAccountBindings)
    .innerJoin(userSystems, eq(userSystems.systemId, systemAccountBindings.systemId))
    .where(
      and(
        eq(systemAccountBindings.accountId, accountId),
        isNull(systemAccountBindings.validTo),
      ),
    );

  const overseers = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(inArray(roles.name, [ADMIN, MANAGER]), eq(users.isActive, true)));

  return [...new Set([...assigned.map((r) => r.userId), ...overseers.map((r) => r.id)])];
}

/**
 * Accounts this caller may read.
 *
 * Same fail-closed contract as `scopeSystems`: `null` means unrestricted, an
 * empty array means nothing. An account is visible when the caller can see at
 * least one machine that has ever been bound to it.
 */
export async function visibleAccountIds(allowed: Allowed): Promise<number[] | null> {
  if (allowed === null) return null;
  if (allowed.length === 0) return [];
  const rows = await db
    .selectDistinct({ accountId: systemAccountBindings.accountId })
    .from(systemAccountBindings)
    .where(inArray(systemAccountBindings.systemId, allowed));
  return rows.map((r) => r.accountId);
}

export interface AccountListRow {
  id: number;
  account_uuid: string;
  email_address: string;
  display_name: string;
  organization_name: string;
  organization_type: string;
  rate_limit_tier: string;
  has_extra_usage_enabled: boolean;
  subscription_created_at: string;
  trial_ends_at: string;
  seat_tier: string;
  last_seen_at: string | null;
  systems: { system_id: string; display_name: string; status: string }[];
  /** Everyone on this subscription, heaviest first, each with their own
   * machines and totals — so a shared account can be read per person. */
  users: {
    id: number;
    email: string;
    full_name: string;
    systems: { system_id: string; display_name: string; status: string }[];
    tokens_today: number;
    tokens_week: number;
  }[];
  unassigned_systems: { system_id: string; display_name: string; status: string }[];
  is_shared: boolean;
  limits: {
    kind: string;
    scope_label: string;
    percent: number;
    severity: string;
    is_active: boolean;
    resets_at: string | null;
    fetched_at: string;
  }[];
  tokens_today: number;
  tokens_week: number;
}

/**
 * Everything the accounts page needs, in four queries rather than N+1.
 *
 * `allowed` scopes the *systems* considered, which in turn scopes the accounts
 * and their token totals — a developer sees their own machines' contribution,
 * not the whole fleet's.
 */
export async function listAccounts(
  allowed: Allowed,
  todayUtc: string,
  weekStartUtc: string,
): Promise<AccountListRow[]> {
  const accountIds = await visibleAccountIds(allowed);
  if (accountIds !== null && accountIds.length === 0) return [];

  const accountFilter =
    accountIds === null ? undefined : inArray(claudeAccounts.id, accountIds);

  const accounts = await db
    .select()
    .from(claudeAccounts)
    .where(accountFilter)
    .orderBy(desc(claudeAccounts.lastSeenAt));
  if (accounts.length === 0) return [];

  const ids = accounts.map((a) => a.id);

  // Currently-bound machines, with the people assigned to them.
  const bindings = await db
    .select({
      accountId: systemAccountBindings.accountId,
      systemId: systems.systemId,
      systemName: systems.displayName,
      lastSeenAt: systems.lastSeenAt,
      userId: users.id,
      userEmail: users.email,
      userName: users.fullName,
    })
    .from(systemAccountBindings)
    .innerJoin(systems, eq(systems.systemId, systemAccountBindings.systemId))
    .leftJoin(userSystems, eq(userSystems.systemId, systems.systemId))
    .leftJoin(users, eq(users.id, userSystems.userId))
    .where(
      and(
        inArray(systemAccountBindings.accountId, ids),
        isNull(systemAccountBindings.validTo),
        scopeSystems(systemAccountBindings.systemId, allowed),
      ),
    );

  // Latest reading per (account, kind).
  const snapshots = await db
    .selectDistinctOn([accountUsageSnapshots.accountId, accountUsageSnapshots.kind], {
      accountId: accountUsageSnapshots.accountId,
      kind: accountUsageSnapshots.kind,
      scopeLabel: accountUsageSnapshots.scopeLabel,
      percent: accountUsageSnapshots.percent,
      severity: accountUsageSnapshots.severity,
      isActive: accountUsageSnapshots.isActive,
      resetsAt: accountUsageSnapshots.resetsAt,
      fetchedAt: accountUsageSnapshots.fetchedAt,
    })
    .from(accountUsageSnapshots)
    .where(inArray(accountUsageSnapshots.accountId, ids))
    .orderBy(
      accountUsageSnapshots.accountId,
      accountUsageSnapshots.kind,
      desc(accountUsageSnapshots.fetchedAt),
    );

  // Token totals for the account's *currently bound* machines. Approximate
  // across a switch — Phase 2 stamps the account onto events at ingest.
  const systemIdsByAccount = new Map<number, string[]>();
  for (const b of bindings) {
    const list = systemIdsByAccount.get(b.accountId) ?? [];
    if (!list.includes(b.systemId)) list.push(b.systemId);
    systemIdsByAccount.set(b.accountId, list);
  }
  const allSystemIds = [...new Set(bindings.map((b) => b.systemId))];
  const totals =
    allSystemIds.length === 0
      ? []
      : await db
          .select({
            systemId: dailyAggregates.systemId,
            today: sql<number>`coalesce(sum(case when ${dailyAggregates.day} = ${todayUtc} then ${dailyAggregates.totalTokens} else 0 end), 0)`,
            week: sql<number>`coalesce(sum(case when ${dailyAggregates.day} >= ${weekStartUtc} then ${dailyAggregates.totalTokens} else 0 end), 0)`,
          })
          .from(dailyAggregates)
          .where(inArray(dailyAggregates.systemId, allSystemIds))
          .groupBy(dailyAggregates.systemId);
  const totalsBySystem = new Map(totals.map((t) => [t.systemId, t]));

  return accounts.map((account) => {
    const own = bindings.filter((b) => b.accountId === account.id);
    const systemMap = new Map<string, { system_id: string; display_name: string; status: string }>();
    const userMap = new Map<
      number,
      {
        id: number;
        email: string;
        full_name: string;
        systems: { system_id: string; display_name: string; status: string }[];
        tokens_today: number;
        tokens_week: number;
      }
    >();
    /** Bound machines nobody owns — otherwise their usage vanishes from the
     * per-person breakdown while still counting toward the account total. */
    const unassigned: { system_id: string; display_name: string; status: string }[] = [];
    let tokensToday = 0;
    let tokensWeek = 0;

    for (const b of own) {
      if (!systemMap.has(b.systemId)) {
        systemMap.set(b.systemId, {
          system_id: b.systemId,
          display_name: b.systemName,
          status: isOnline(b.lastSeenAt) ? "online" : "offline",
        });
        const t = totalsBySystem.get(b.systemId);
        tokensToday += Number(t?.today ?? 0);
        tokensWeek += Number(t?.week ?? 0);
      }
      const systemRef = systemMap.get(b.systemId)!;

      if (b.userId === null) {
        if (!unassigned.some((s) => s.system_id === b.systemId)) unassigned.push(systemRef);
        continue;
      }

      let entry = userMap.get(b.userId);
      if (!entry) {
        entry = {
          id: b.userId,
          email: b.userEmail ?? "",
          full_name: b.userName ?? "",
          systems: [],
          tokens_today: 0,
          tokens_week: 0,
        };
        userMap.set(b.userId, entry);
      }
      // Per-person totals are the usage of that person's machines on this
      // account. A machine assigned to two people counts once for each — the
      // figures describe attribution, and do not sum to the account total.
      if (!entry.systems.some((s) => s.system_id === b.systemId)) {
        entry.systems.push(systemRef);
        const t = totalsBySystem.get(b.systemId);
        entry.tokens_today += Number(t?.today ?? 0);
        entry.tokens_week += Number(t?.week ?? 0);
      }
    }

    const usersOut = [...userMap.values()].sort((a, b) => b.tokens_week - a.tokens_week);

    return {
      id: account.id,
      account_uuid: account.accountUuid,
      email_address: account.emailAddress,
      display_name: account.displayName,
      organization_name: account.organizationName,
      organization_type: account.organizationType,
      rate_limit_tier: account.rateLimitTier,
      has_extra_usage_enabled: account.hasExtraUsageEnabled,
      subscription_created_at: account.subscriptionCreatedAt,
      trial_ends_at: account.trialEndsAt,
      seat_tier: account.seatTier,
      last_seen_at: account.lastSeenAt?.toISOString() ?? null,
      systems: [...systemMap.values()],
      users: usersOut,
      unassigned_systems: unassigned,
      /** More than one person on the same Claude subscription. */
      is_shared: usersOut.length > 1,
      limits: snapshots
        .filter((s) => s.accountId === account.id)
        .map((s) => ({
          kind: s.kind,
          scope_label: s.scopeLabel,
          percent: Number(s.percent),
          severity: s.severity,
          is_active: s.isActive,
          resets_at: s.resetsAt?.toISOString() ?? null,
          fetched_at: s.fetchedAt.toISOString(),
        })),
      tokens_today: tokensToday,
      tokens_week: tokensWeek,
    };
  });
}