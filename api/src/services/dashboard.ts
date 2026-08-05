/**
 * Dashboard shaping — turns scoped repository reads into API payloads.
 */

import { deriveAgentHealth } from "../core/agentHealth.js";
import * as repo from "../repositories/dashboard.js";
import { isEmptyScope, type Allowed } from "../repositories/scope.js";
import {
  daysAgoUtc,
  isOnline,
  lastNDaysUtc,
  monthStartUtc,
  todayUtc,
} from "../core/time.js";
import type { SystemRow } from "../db/schema.js";

export interface RankingItem {
  system_id: string;
  display_name: string;
  total_tokens: number;
  pct: number;
}

/**
 * Rank systems by tokens.
 *
 * `pct` is share of the *visible* total. For a scoped user that is not the
 * fleet-wide share, so responses carry a `scoped` flag and the UI labels the
 * column accordingly instead of implying a fleet percentage.
 */
function buildRanking(
  systems: SystemRow[],
  totals: Map<string, number>,
): RankingItem[] {
  const grand = systems.reduce((n, s) => n + (totals.get(s.systemId) ?? 0), 0) || 1;
  return systems
    .map((s) => {
      const total = totals.get(s.systemId) ?? 0;
      return {
        system_id: s.systemId,
        display_name: s.displayName,
        total_tokens: total,
        pct: Math.round((total / grand) * 1000) / 10,
      };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

export async function buildSummary(allowed: Allowed) {
  const scoped = allowed !== null;

  if (isEmptyScope(allowed)) {
    return {
      today_tokens: 0,
      week_tokens: 0,
      month_tokens: 0,
      total_tokens: 0,
      active_systems: 0,
      total_systems: 0,
      highest: null,
      scoped,
    };
  }

  const [systems, totals, today, week, month, total] = await Promise.all([
    repo.listSystems(allowed),
    repo.totalsBySystem(allowed),
    repo.sumTokens(allowed, todayUtc()),
    repo.sumTokens(allowed, daysAgoUtc(6)),
    repo.sumTokens(allowed, monthStartUtc()),
    repo.sumTokens(allowed),
  ]);

  const ranking = buildRanking(systems, totals);
  const now = new Date();

  return {
    today_tokens: today,
    week_tokens: week,
    month_tokens: month,
    total_tokens: total,
    active_systems: systems.filter((s) => isOnline(s.lastSeenAt, now)).length,
    total_systems: systems.length,
    highest: ranking[0] ?? null,
    scoped,
  };
}

export async function buildRankingList(allowed: Allowed, sinceDay?: string) {
  const [systems, totals] = await Promise.all([
    repo.listSystems(allowed),
    repo.totalsBySystem(allowed, sinceDay),
  ]);
  return buildRanking(systems, totals);
}

export async function buildTimeseries(allowed: Allowed, days: number) {
  const startDay = daysAgoUtc(days - 1);
  const [systems, totals, rows] = await Promise.all([
    repo.listSystems(allowed),
    repo.totalsBySystem(allowed, startDay),
    repo.timeseriesRows(allowed, startDay),
  ]);

  const dayList = lastNDaysUtc(days);
  const byDay = new Map<string, Record<string, number>>(dayList.map((d) => [d, {}]));
  for (const r of rows) {
    const bucket = byDay.get(r.day) ?? {};
    bucket[r.systemId] = Number(r.total);
    byDay.set(r.day, bucket);
  }

  return {
    days: dayList,
    systems: buildRanking(systems, totals),
    points: dayList.map((d) => ({ day: d, values: byDay.get(d) ?? {} })),
  };
}

/** Systems list decorated with live status and per-system stats. */
export async function decorateSystems(allowed: Allowed) {
  const [systems, stats] = await Promise.all([
    repo.listSystems(allowed),
    repo.systemStats(allowed),
  ]);
  const now = new Date();

  return systems.map((s) => {
    const st = stats.get(s.systemId);
    return {
      system_id: s.systemId,
      display_name: s.displayName,
      hostname: s.hostname,
      agent_version: s.agentVersion,
      owner: s.owner,
      location: s.location,
      environment: s.environment,
      notes: s.notes,
      last_seen_at: s.lastSeenAt?.toISOString() ?? null,
      last_sync_at: s.lastSyncAt?.toISOString() ?? null,
      created_at: s.createdAt.toISOString(),
      status: isOnline(s.lastSeenAt, now) ? ("online" as const) : ("offline" as const),
      // Graded liveness alongside the binary flag: "offline" cannot tell a
      // sleeping laptop from an agent that died when its terminal closed.
      ...deriveAgentHealth(s.lastSeenAt, now),
      total_tokens: st?.totalTokens ?? 0,
      sessions: st?.sessions ?? 0,
      projects: st?.projects ?? 0,
      never_synced: s.lastSyncAt === null,
    };
  });
}
