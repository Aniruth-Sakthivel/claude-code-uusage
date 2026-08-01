/**
 * Per-user routes, backing the master-detail session view.
 *
 * Authorization has two layers here, and both matter:
 *   - **Enumeration** (`/people`) needs `view_all`. Without it a developer
 *     could list every colleague's activity.
 *   - **Detail** is allowed for `view_all` holders, or for the caller's own
 *     id. Anyone may look at their own usage.
 * Data is then scoped again by `visibleSystemIds`, so even a permitted read
 * only covers machines the caller may see.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { currentUser, requireUser } from "../core/guards.js";
import { forbidden, notFound } from "../core/errors.js";
import { can, visibleSystemIds } from "../core/rbac.js";
import { daysAgoUtc, todayUtc } from "../core/time.js";
import * as repo from "../repositories/people.js";
import { derivePlan } from "../core/plans.js";

const RANGE_DAYS: Record<string, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

const listQuery = z.object({
  range: z.enum(["today", "7d", "30d", "90d"]).default("30d"),
});

const sessionQuery = z.object({
  range: z.enum(["today", "7d", "30d", "90d"]).default("30d"),
  project: z.string().max(255).optional(),
  status: z.enum(["active", "idle"]).optional(),
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function sinceDayFor(range: string): string {
  return daysAgoUtc((RANGE_DAYS[range] ?? 30) - 1);
}

export async function peopleRoutes(app: FastifyInstance) {
  /** Master list. Enumerating people requires `view_all`. */
  app.get("/api/v1/people", { preHandler: requireUser }, async (req) => {
    const user = currentUser(req);
    if (!can(user, "view_all")) throw forbidden("Requires capability: view_all");

    const { range } = listQuery.parse(req.query ?? {});
    const people = await repo.listPeople(
      visibleSystemIds(user),
      todayUtc(),
      sinceDayFor(range),
    );

    return {
      people: people.map((p) => ({
        ...p,
        plan_label: p.account_org_type
          ? derivePlan(p.account_org_type, p.account_rate_limit_tier ?? "").label
          : null,
      })),
      range,
    };
  });

  /** Detail for one person. Own id is always allowed. */
  app.get("/api/v1/people/:id", { preHandler: requireUser }, async (req) => {
    const user = currentUser(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw notFound("User not found");
    if (id !== user.id && !can(user, "view_all")) {
      throw forbidden("You may only view your own activity.");
    }

    const { range } = listQuery.parse(req.query ?? {});
    const sinceDay = sinceDayFor(range);
    const allowed = visibleSystemIds(user);
    const systemIds = await repo.systemIdsForUser(id, allowed);

    const [people, projects, series] = await Promise.all([
      repo.listPeople(allowed, todayUtc(), sinceDay),
      repo.listPersonProjects(systemIds, sinceDay),
      repo.personTimeseries(systemIds, sinceDay),
    ]);

    const person = people.find((p) => p.id === id);
    if (!person) throw notFound("User not found");

    return {
      person: {
        ...person,
        plan_label: person.account_org_type
          ? derivePlan(person.account_org_type, person.account_rate_limit_tier ?? "").label
          : null,
      },
      projects,
      timeseries: series,
      range,
    };
  });

  /**
   * One person's sessions — filtered and paged server-side.
   *
   * The fleet-wide `/sessions` endpoint caps at 200 rows, so paging this
   * client-side would silently hide a person's history behind other people's.
   */
  app.get("/api/v1/people/:id/sessions", { preHandler: requireUser }, async (req) => {
    const user = currentUser(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw notFound("User not found");
    if (id !== user.id && !can(user, "view_all")) {
      throw forbidden("You may only view your own activity.");
    }

    const q = sessionQuery.parse(req.query ?? {});
    const systemIds = await repo.systemIdsForUser(id, visibleSystemIds(user));
    const { rows, total } = await repo.listPersonSessions(systemIds, {
      sinceDay: sinceDayFor(q.range),
      project: q.project,
      status: q.status,
      limit: q.pageSize,
      offset: q.page * q.pageSize,
    });

    return {
      sessions: rows,
      total,
      page: q.page,
      page_size: q.pageSize,
      page_count: Math.max(1, Math.ceil(total / q.pageSize)),
    };
  });
}
