/**
 * Per-user reads — the first endpoints in this codebase keyed by *person*
 * rather than by machine.
 *
 * A person's usage is the union of their assigned machines (`user_systems`),
 * which is why every query here starts by resolving that set and then reuses
 * the same fail-closed scoping as everything else.
 *
 * The session list is server-filtered and server-paged on purpose. The older
 * `listSessions` caps at 200 rows fleet-wide, so filtering client-side would
 * show a given person nothing at all simply because other people's sessions
 * filled the cap.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  claudeAccounts,
  dailyAggregates,
  promptDaily,
  sessionMeta,
  systemAccountBindings,
  systems,
  usageEvents,
  userSystems,
  users,
  roles,
} from "../db/schema.js";
import { isOnline } from "../core/time.js";
import {
  deriveScanActivity,
  type ScanActivityInput,
  type ScanActivityView,
} from "../core/scanActivity.js";
import { isEmptyScope, scopeSystems, type Allowed } from "./scope.js";

/**
 * The machine that best represents a person's current agent state: one that is
 * actively scanning if any is, otherwise whichever reported most recently.
 */
function liveliest(machines: ScanActivityInput[], now: Date): ScanActivityView {
  const views = machines.map((m) => ({ m, v: deriveScanActivity(m, now) }));
  const busy = views.find((x) => x.v.scanning);
  if (busy) return busy.v;

  let best: (typeof views)[number] | undefined;
  for (const candidate of views) {
    const at = candidate.m.agentStatusAt?.getTime() ?? -1;
    const bestAt = best?.m.agentStatusAt?.getTime() ?? -1;
    if (at > bestAt) best = candidate;
  }
  return best?.v ?? deriveScanActivity(EMPTY_SCAN, now);
}

const EMPTY_SCAN: ScanActivityInput = {
  agentStatus: "",
  agentStatusAt: null,
  agentStatusDetail: "",
  scanIntervalSeconds: null,
  lastScanAt: null,
  lastScanDurationMs: null,
};

/** Machines assigned to a person, intersected with what the caller may see. */
export async function systemIdsForUser(userId: number, allowed: Allowed): Promise<string[]> {
  if (isEmptyScope(allowed)) return [];
  const rows = await db
    .select({ systemId: userSystems.systemId })
    .from(userSystems)
    .where(eq(userSystems.userId, userId));
  const mine = rows.map((r) => r.systemId);
  if (allowed === null) return mine;
  return mine.filter((id) => allowed.includes(id));
}

export interface PersonRow {
  id: number;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  status: "online" | "offline";
  system_count: number;
  /** Claude account currently bound to any of their machines. */
  account_email: string | null;
  account_org_type: string | null;
  account_rate_limit_tier: string | null;
  tokens_today: number;
  tokens_range: number;
  sessions: number;
  projects: number;
  prompts: number | null;
  last_active: string | null;
  /**
   * Live agent state for this person, taken from their most recently reporting
   * machine. Someone with two PCs is "scanning" if either one is — the question
   * being answered is "is this person's usage being collected right now?", and
   * a per-machine breakdown belongs on the Systems page.
   */
  scan: ScanActivityView;
}

/**
 * Everyone, with enough summary to render the master list and rank it.
 *
 * Deliberately a handful of grouped queries rather than one per person: the
 * left panel shows every user at once, so N+1 here would be N+1 round trips
 * on every page load.
 */
export async function listPeople(
  allowed: Allowed,
  todayUtc: string,
  sinceDay: string,
): Promise<PersonRow[]> {
  const people = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: roles.name,
      isActive: users.isActive,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .orderBy(users.email);
  if (people.length === 0) return [];

  // user -> systems (scoped)
  const assignments = await db
    .select({
      userId: userSystems.userId,
      systemId: userSystems.systemId,
      lastSeenAt: systems.lastSeenAt,
      agentStatus: systems.agentStatus,
      agentStatusAt: systems.agentStatusAt,
      agentStatusDetail: systems.agentStatusDetail,
      scanIntervalSeconds: systems.scanIntervalSeconds,
      lastScanAt: systems.lastScanAt,
      lastScanDurationMs: systems.lastScanDurationMs,
    })
    .from(userSystems)
    .innerJoin(systems, eq(systems.systemId, userSystems.systemId))
    .where(scopeSystems(userSystems.systemId, allowed));

  type OwnedSystem = ScanActivityInput & { id: string; lastSeenAt: Date | null };
  const systemsByUser = new Map<number, OwnedSystem[]>();
  for (const a of assignments) {
    const list = systemsByUser.get(a.userId) ?? [];
    list.push({ ...a, id: a.systemId });
    systemsByUser.set(a.userId, list);
  }
  const now = new Date();

  const allSystemIds = [...new Set(assignments.map((a) => a.systemId))];
  if (allSystemIds.length === 0) {
    return people.map((p) => emptyPerson(p));
  }

  // Token totals per system (rollup — cheap).
  const totals = await db
    .select({
      systemId: dailyAggregates.systemId,
      today: sql<number>`coalesce(sum(case when ${dailyAggregates.day} = ${todayUtc} then ${dailyAggregates.totalTokens} else 0 end), 0)`,
      range: sql<number>`coalesce(sum(case when ${dailyAggregates.day} >= ${sinceDay} then ${dailyAggregates.totalTokens} else 0 end), 0)`,
    })
    .from(dailyAggregates)
    .where(inArray(dailyAggregates.systemId, allSystemIds))
    .groupBy(dailyAggregates.systemId);
  const totalsBySystem = new Map(totals.map((t) => [t.systemId, t]));

  // Session / project / recency per system, over the window.
  const activity = await db
    .select({
      systemId: usageEvents.systemId,
      sessions: sql<number>`count(distinct ${usageEvents.sessionId})`,
      projects: sql<number>`count(distinct ${usageEvents.projectName})`,
      lastTs: sql<string>`max(${usageEvents.tsUtc})`,
    })
    .from(usageEvents)
    .where(and(inArray(usageEvents.systemId, allSystemIds), gte(usageEvents.day, sinceDay)))
    .groupBy(usageEvents.systemId);
  const activityBySystem = new Map(activity.map((a) => [a.systemId, a]));

  // Prompt counts — absent for history predating prompt collection, which the
  // UI renders as "—" rather than a misleading zero.
  const prompts = await db
    .select({
      systemId: promptDaily.systemId,
      total: sql<number>`coalesce(sum(${promptDaily.promptCount}), 0)`,
    })
    .from(promptDaily)
    .where(and(inArray(promptDaily.systemId, allSystemIds), gte(promptDaily.day, sinceDay)))
    .groupBy(promptDaily.systemId);
  const promptsBySystem = new Map(prompts.map((p) => [p.systemId, Number(p.total)]));

  // Currently bound Claude account per system.
  const bindings = await db
    .select({
      systemId: systemAccountBindings.systemId,
      email: claudeAccounts.emailAddress,
      orgType: claudeAccounts.organizationType,
      tier: claudeAccounts.rateLimitTier,
    })
    .from(systemAccountBindings)
    .innerJoin(claudeAccounts, eq(claudeAccounts.id, systemAccountBindings.accountId))
    .where(
      and(
        inArray(systemAccountBindings.systemId, allSystemIds),
        sql`${systemAccountBindings.validTo} is null`,
      ),
    );
  const accountBySystem = new Map(bindings.map((b) => [b.systemId, b]));

  return people.map((p) => {
    const owned = systemsByUser.get(p.id) ?? [];
    if (owned.length === 0) return emptyPerson(p);

    let tokensToday = 0;
    let tokensRange = 0;
    let sessions = 0;
    let projects = 0;
    let promptTotal = 0;
    let sawPrompts = false;
    let lastActive: string | null = null;
    let online = false;
    let account: { email: string; orgType: string; tier: string } | null = null;

    for (const s of owned) {
      const t = totalsBySystem.get(s.id);
      tokensToday += Number(t?.today ?? 0);
      tokensRange += Number(t?.range ?? 0);

      const a = activityBySystem.get(s.id);
      sessions += Number(a?.sessions ?? 0);
      // Projects across machines can overlap; this is an upper bound, and the
      // detail view computes the exact distinct count for one person.
      projects += Number(a?.projects ?? 0);
      if (a?.lastTs && (!lastActive || a.lastTs > lastActive)) lastActive = a.lastTs;

      const pr = promptsBySystem.get(s.id);
      if (pr !== undefined) {
        promptTotal += pr;
        sawPrompts = true;
      }

      if (isOnline(s.lastSeenAt)) online = true;
      const acc = accountBySystem.get(s.id);
      if (acc && !account) account = { email: acc.email, orgType: acc.orgType, tier: acc.tier };
    }

    return {
      id: p.id,
      email: p.email,
      full_name: p.fullName,
      role: p.role,
      is_active: p.isActive,
      status: online ? ("online" as const) : ("offline" as const),
      system_count: owned.length,
      account_email: account?.email ?? null,
      account_org_type: account?.orgType ?? null,
      account_rate_limit_tier: account?.tier ?? null,
      tokens_today: tokensToday,
      tokens_range: tokensRange,
      sessions,
      projects,
      prompts: sawPrompts ? promptTotal : null,
      last_active: lastActive,
      scan: liveliest(owned, now),
    };
  });
}

function emptyPerson(p: {
  id: number;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
}): PersonRow {
  return {
    id: p.id,
    email: p.email,
    full_name: p.fullName,
    role: p.role,
    is_active: p.isActive,
    status: "offline",
    system_count: 0,
    account_email: null,
    account_org_type: null,
    account_rate_limit_tier: null,
    tokens_today: 0,
    tokens_range: 0,
    sessions: 0,
    projects: 0,
    prompts: null,
    last_active: null,
    // No machine assigned, so there is nothing scanning on this person's
    // behalf — reported as unknown rather than idle, which would imply an agent
    // that is merely between scans.
    scan: deriveScanActivity(EMPTY_SCAN),
  };
}

export interface PersonSessionRow {
  session_id: string;
  system_id: string;
  system_name: string;
  project_name: string;
  model: string;
  title: string | null;
  first_ts: string;
  last_ts: string;
  prompts: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  total_tokens: number;
}

/**
 * One person's sessions, filtered and paged on the server.
 *
 * `status` is derived rather than stored: a session counts as active when its
 * most recent event is within `ACTIVE_WINDOW_MS`. There is no session
 * open/close signal in the transcripts, so this is an inference — named
 * "active" rather than "running" for that reason.
 */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

export async function listPersonSessions(
  systemIds: string[],
  opts: {
    sinceDay: string;
    project?: string;
    status?: "active" | "idle";
    limit: number;
    offset: number;
  },
): Promise<{ rows: PersonSessionRow[]; total: number }> {
  if (systemIds.length === 0) return { rows: [], total: 0 };

  const filters = [inArray(usageEvents.systemId, systemIds), gte(usageEvents.day, opts.sinceDay)];
  if (opts.project) filters.push(eq(usageEvents.projectName, opts.project));

  const grouped = db
    .select({
      sessionId: usageEvents.sessionId,
      systemId: usageEvents.systemId,
      projectName: sql<string>`max(${usageEvents.projectName})`,
      model: sql<string>`max(${usageEvents.model})`,
      firstTs: sql<string>`min(${usageEvents.tsUtc})`,
      lastTs: sql<string>`max(${usageEvents.tsUtc})`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheTokens: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens} + ${usageEvents.cacheCreationTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)`,
    })
    .from(usageEvents)
    .where(and(...filters))
    .groupBy(usageEvents.sessionId, usageEvents.systemId)
    .orderBy(desc(sql`max(${usageEvents.tsUtc})`));

  const all = await grouped;

  // Status is derived from the aggregate, so it is filtered after grouping.
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
  const filtered = opts.status
    ? all.filter((r) =>
        opts.status === "active" ? (r.lastTs ?? "") >= cutoff : (r.lastTs ?? "") < cutoff,
      )
    : all;

  const page = filtered.slice(opts.offset, opts.offset + opts.limit);
  if (page.length === 0) return { rows: [], total: filtered.length };

  const sessionIds = page.map((r) => r.sessionId);

  const [names, titles, prompts] = await Promise.all([
    db
      .select({ systemId: systems.systemId, displayName: systems.displayName })
      .from(systems)
      .where(inArray(systems.systemId, systemIds)),
    db
      .select({
        systemId: sessionMeta.systemId,
        sessionId: sessionMeta.sessionId,
        title: sessionMeta.title,
      })
      .from(sessionMeta)
      .where(
        and(inArray(sessionMeta.systemId, systemIds), inArray(sessionMeta.sessionId, sessionIds)),
      ),
    db
      .select({
        systemId: promptDaily.systemId,
        sessionId: promptDaily.sessionId,
        total: sql<number>`coalesce(sum(${promptDaily.promptCount}), 0)`,
      })
      .from(promptDaily)
      .where(
        and(inArray(promptDaily.systemId, systemIds), inArray(promptDaily.sessionId, sessionIds)),
      )
      .groupBy(promptDaily.systemId, promptDaily.sessionId),
  ]);

  const nameBySystem = new Map(names.map((n) => [n.systemId, n.displayName]));
  const titleByKey = new Map(titles.map((t) => [`${t.systemId}|${t.sessionId}`, t.title]));
  const promptsByKey = new Map(
    prompts.map((p) => [`${p.systemId}|${p.sessionId}`, Number(p.total)]),
  );

  return {
    total: filtered.length,
    rows: page.map((r) => {
      const key = `${r.systemId}|${r.sessionId}`;
      return {
        session_id: r.sessionId,
        system_id: r.systemId,
        system_name: nameBySystem.get(r.systemId) ?? r.systemId,
        project_name: r.projectName ?? "unknown",
        model: r.model ?? "",
        title: titleByKey.get(key) ?? null,
        first_ts: r.firstTs ?? "",
        last_ts: r.lastTs ?? "",
        prompts: promptsByKey.get(key) ?? null,
        input_tokens: Number(r.inputTokens),
        output_tokens: Number(r.outputTokens),
        cache_tokens: Number(r.cacheTokens),
        total_tokens: Number(r.totalTokens),
      };
    }),
  };
}

/** Distinct projects a person touched in the window, for the filter dropdown. */
export async function listPersonProjects(
  systemIds: string[],
  sinceDay: string,
): Promise<{ project_name: string; sessions: number; total_tokens: number }[]> {
  if (systemIds.length === 0) return [];
  const rows = await db
    .select({
      projectName: usageEvents.projectName,
      sessions: sql<number>`count(distinct ${usageEvents.sessionId})`,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)`,
    })
    .from(usageEvents)
    .where(and(inArray(usageEvents.systemId, systemIds), gte(usageEvents.day, sinceDay)))
    .groupBy(usageEvents.projectName)
    .orderBy(desc(sql`coalesce(sum(${usageEvents.totalTokens}), 0)`));
  return rows.map((r) => ({
    project_name: r.projectName ?? "unknown",
    sessions: Number(r.sessions),
    total_tokens: Number(r.totalTokens),
  }));
}

/** Daily token totals for one person, for the detail chart. */
export async function personTimeseries(
  systemIds: string[],
  sinceDay: string,
): Promise<{ day: string; total_tokens: number }[]> {
  if (systemIds.length === 0) return [];
  const rows = await db
    .select({
      day: dailyAggregates.day,
      totalTokens: sql<number>`coalesce(sum(${dailyAggregates.totalTokens}), 0)`,
    })
    .from(dailyAggregates)
    .where(and(inArray(dailyAggregates.systemId, systemIds), gte(dailyAggregates.day, sinceDay)))
    .groupBy(dailyAggregates.day)
    .orderBy(dailyAggregates.day);
  return rows.map((r) => ({ day: r.day, total_tokens: Number(r.totalTokens) }));
}
