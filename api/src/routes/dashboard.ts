/**
 * Dashboard + scoped read routes.
 *
 * Every handler derives `allowed` from the authenticated user and passes it to
 * the service layer, which passes it to repositories. No handler ever queries
 * unscoped.
 */

import type { FastifyInstance } from "fastify";

import { currentUser, requireUser } from "../core/guards.js";
import { visibleSystemIds } from "../core/rbac.js";
import { daysAgoUtc } from "../core/time.js";
import * as repo from "../repositories/dashboard.js";
import { allowsSystem } from "../repositories/scope.js";
import { notFound } from "../core/errors.js";
import * as dash from "../services/dashboard.js";
import { rangeQuery } from "../schemas/index.js";

const RANGE_DAYS: Record<string, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/v1/dashboard/summary", { preHandler: requireUser }, async (req) =>
    dash.buildSummary(visibleSystemIds(currentUser(req))),
  );

  app.get("/api/v1/dashboard/ranking", { preHandler: requireUser }, async (req) => {
    const { range } = rangeQuery.parse(req.query ?? {});
    const days = RANGE_DAYS[range] ?? 7;
    return dash.buildRankingList(
      visibleSystemIds(currentUser(req)),
      daysAgoUtc(days - 1),
    );
  });

  app.get("/api/v1/dashboard/timeseries", { preHandler: requireUser }, async (req) => {
    const { range } = rangeQuery.parse(req.query ?? {});
    return dash.buildTimeseries(
      visibleSystemIds(currentUser(req)),
      RANGE_DAYS[range] ?? 7,
    );
  });

  app.get("/api/v1/systems", { preHandler: requireUser }, async (req) =>
    dash.decorateSystems(visibleSystemIds(currentUser(req))),
  );

  /** Live agent status — powers "last scan 3 min ago" vs "never scanned". */
  app.get<{ Params: { id: string } }>(
    "/api/v1/systems/:id/status",
    { preHandler: requireUser },
    async (req) => {
      const allowed = visibleSystemIds(currentUser(req));
      const { id } = req.params;
      if (!allowsSystem(allowed, id)) throw notFound("System not found");

      const s = await repo.getSystem(id);
      if (!s) throw notFound("System not found");

      const { isOnline } = await import("../core/time.js");
      return {
        system_id: s.systemId,
        display_name: s.displayName,
        status: isOnline(s.lastSeenAt) ? "online" : "offline",
        last_seen_at: s.lastSeenAt?.toISOString() ?? null,
        last_sync_at: s.lastSyncAt?.toISOString() ?? null,
        total_events: s.totalEvents,
        never_synced: s.lastSyncAt === null,
      };
    },
  );

  app.get("/api/v1/projects", { preHandler: requireUser }, async (req) => {
    const rows = await repo.listProjects(visibleSystemIds(currentUser(req)));
    return rows.map((r) => ({
      project_name: r.projectName,
      system_id: r.systemId,
      total_tokens: r.totalTokens,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_tokens: r.cacheReadTokens,
      cache_creation_tokens: r.cacheCreationTokens,
      sessions: r.sessions,
    }));
  });

  app.get("/api/v1/sessions", { preHandler: requireUser }, async (req) => {
    const rows = await repo.listSessions(visibleSystemIds(currentUser(req)));
    return rows.map((r) => ({
      session_id: r.sessionId,
      system_id: r.systemId,
      project_name: r.projectName,
      model: r.model,
      first_ts: r.firstTs,
      last_ts: r.lastTs,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_tokens: r.cacheTokens,
      total_tokens: r.totalTokens,
    }));
  });
}
