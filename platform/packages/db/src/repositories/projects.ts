/**
 * Project repository.
 *
 * Every exported function takes `ctx: RequestContext` first and routes its
 * WHERE clause through `scoped()`. The poison-row suite reflects over this
 * module's exports, so a function added here is covered automatically — and a
 * function that forgets the guard fails the build.
 */

import { and, eq, sql } from "drizzle-orm";

import type { RequestContext } from "@platform/core";

import { projects } from "../schema/tenancy.js";
import { scoped } from "../scope.js";
import type { Db } from "../client.js";

export async function listProjects(ctx: RequestContext, db: Db) {
  return db
    .select()
    .from(projects)
    .where(
      scoped(projects.workspaceId, ctx, {
        projectColumn: projects.id,
        deletedAtColumn: projects.deletedAt,
      }),
    );
}

export async function getProject(ctx: RequestContext, db: Db, id: string) {
  const rows = await db
    .select()
    .from(projects)
    .where(
      and(
        scoped(projects.workspaceId, ctx, {
          projectColumn: projects.id,
          deletedAtColumn: projects.deletedAt,
        }),
        eq(projects.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function renameProject(
  ctx: RequestContext,
  db: Db,
  id: string,
  name: string,
) {
  return db
    .update(projects)
    .set({ name, updatedAt: new Date(), version: sql`${projects.version} + 1` })
    .where(
      and(
        scoped(projects.workspaceId, ctx, {
          projectColumn: projects.id,
          deletedAtColumn: projects.deletedAt,
        }),
        eq(projects.id, id),
      ),
    )
    .returning();
}

export async function softDeleteProject(ctx: RequestContext, db: Db, id: string) {
  return db
    .update(projects)
    .set({ deletedAt: new Date(), version: sql`${projects.version} + 1` })
    .where(
      and(
        scoped(projects.workspaceId, ctx, {
          projectColumn: projects.id,
          deletedAtColumn: projects.deletedAt,
        }),
        eq(projects.id, id),
      ),
    )
    .returning();
}
