/**
 * Dashboard read queries — all scoped, all UTC.
 *
 * Totals and time series read from `daily_aggregates` (the rollup) rather than
 * scanning `usage_events`, which is what the Python version did six times per
 * page load. Project and session views still read the event table because they
 * group by dimensions the rollup deliberately does not carry.
 */

import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import { db } from "../db/client.js";
import { dailyAggregates, systems, usageEvents } from "../db/schema.js";
import { scopeSystems, isEmptyScope, type Allowed } from "./scope.js";

function where(...parts: (SQL | undefined)[]): SQL | undefined {
  const kept = parts.filter((p): p is SQL => p !== undefined);
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0] : and(...kept);
}

// ── systems ───────────────────────────────────────────────────────────────────
export async function listSystems(allowed: Allowed) {
  if (isEmptyScope(allowed)) return [];
  return db
    .select()
    .from(systems)
    .where(scopeSystems(systems.systemId, allowed))
    .orderBy(systems.displayName);
}

export async function getSystem(systemId: string) {
  const rows = await db
    .select()
    .from(systems)
    .where(eq(systems.systemId, systemId))
    .limit(1);
  return rows[0] ?? null;
}

/** Per-system totals, session count, and project count. */
export async function systemStats(allowed: Allowed) {
  if (isEmptyScope(allowed)) return new Map<string, SystemStat>();

  const rows = await db
    .select({
      systemId: usageEvents.systemId,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)::bigint`,
      sessions: sql<number>`count(distinct ${usageEvents.sessionId})::int`,
      projects: sql<number>`count(distinct ${usageEvents.projectName})::int`,
    })
    .from(usageEvents)
    .where(scopeSystems(usageEvents.systemId, allowed))
    .groupBy(usageEvents.systemId);

  const out = new Map<string, SystemStat>();
  for (const r of rows) {
    out.set(r.systemId, {
      totalTokens: Number(r.totalTokens),
      sessions: Number(r.sessions),
      projects: Number(r.projects),
    });
  }
  return out;
}

export interface SystemStat {
  totalTokens: number;
  sessions: number;
  projects: number;
}

// ── totals (from the rollup) ──────────────────────────────────────────────────
export async function sumTokens(allowed: Allowed, sinceDay?: string): Promise<number> {
  if (isEmptyScope(allowed)) return 0;

  const rows = await db
    .select({
      total: sql<number>`coalesce(sum(${dailyAggregates.totalTokens}), 0)::bigint`,
    })
    .from(dailyAggregates)
    .where(
      where(
        scopeSystems(dailyAggregates.systemId, allowed),
        sinceDay ? gte(dailyAggregates.day, sinceDay) : undefined,
      ),
    );

  return Number(rows[0]?.total ?? 0);
}

export async function totalsBySystem(
  allowed: Allowed,
  sinceDay?: string,
): Promise<Map<string, number>> {
  if (isEmptyScope(allowed)) return new Map();

  const rows = await db
    .select({
      systemId: dailyAggregates.systemId,
      total: sql<number>`coalesce(sum(${dailyAggregates.totalTokens}), 0)::bigint`,
    })
    .from(dailyAggregates)
    .where(
      where(
        scopeSystems(dailyAggregates.systemId, allowed),
        sinceDay ? gte(dailyAggregates.day, sinceDay) : undefined,
      ),
    )
    .groupBy(dailyAggregates.systemId);

  return new Map(rows.map((r) => [r.systemId, Number(r.total)]));
}

export async function timeseriesRows(allowed: Allowed, startDay: string) {
  if (isEmptyScope(allowed)) return [];

  return db
    .select({
      day: dailyAggregates.day,
      systemId: dailyAggregates.systemId,
      total: sql<number>`coalesce(sum(${dailyAggregates.totalTokens}), 0)::bigint`,
    })
    .from(dailyAggregates)
    .where(
      where(
        scopeSystems(dailyAggregates.systemId, allowed),
        gte(dailyAggregates.day, startDay),
      ),
    )
    .groupBy(dailyAggregates.day, dailyAggregates.systemId)
    .orderBy(dailyAggregates.day);
}

// ── projects / sessions (metadata only — never content) ───────────────────────
export async function listProjects(allowed: Allowed) {
  if (isEmptyScope(allowed)) return [];

  const rows = await db
    .select({
      projectName: usageEvents.projectName,
      systemId: usageEvents.systemId,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)::bigint`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::bigint`,
      cacheReadTokens: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)::bigint`,
      cacheCreationTokens: sql<number>`coalesce(sum(${usageEvents.cacheCreationTokens}), 0)::bigint`,
      sessions: sql<number>`count(distinct ${usageEvents.sessionId})::int`,
    })
    .from(usageEvents)
    .where(scopeSystems(usageEvents.systemId, allowed))
    .groupBy(usageEvents.projectName, usageEvents.systemId)
    .orderBy(desc(sql`sum(${usageEvents.totalTokens})`));

  return rows.map((r) => ({
    projectName: r.projectName,
    systemId: r.systemId,
    totalTokens: Number(r.totalTokens),
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheCreationTokens: Number(r.cacheCreationTokens),
    sessions: Number(r.sessions),
  }));
}

export async function listSessions(allowed: Allowed, limit = 200) {
  if (isEmptyScope(allowed)) return [];

  const rows = await db
    .select({
      sessionId: usageEvents.sessionId,
      systemId: usageEvents.systemId,
      projectName: sql<string>`max(${usageEvents.projectName})`,
      model: sql<string>`max(${usageEvents.model})`,
      firstTs: sql<string>`min(${usageEvents.tsUtc})`,
      lastTs: sql<string>`max(${usageEvents.tsUtc})`,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::bigint`,
      cacheTokens: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens} + ${usageEvents.cacheCreationTokens}), 0)::bigint`,
      totalTokens: sql<number>`coalesce(sum(${usageEvents.totalTokens}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(scopeSystems(usageEvents.systemId, allowed))
    .groupBy(usageEvents.sessionId, usageEvents.systemId)
    .orderBy(desc(sql`max(${usageEvents.tsUtc})`))
    .limit(limit);

  return rows.map((r) => ({
    sessionId: r.sessionId,
    systemId: r.systemId,
    projectName: r.projectName ?? "unknown",
    model: r.model ?? "",
    firstTs: r.firstTs ?? "",
    lastTs: r.lastTs ?? "",
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheTokens: Number(r.cacheTokens),
    totalTokens: Number(r.totalTokens),
  }));
}
