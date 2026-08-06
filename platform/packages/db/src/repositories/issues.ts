/**
 * Issue repository. Same contract as every other: `ctx` first, `scoped()`
 * always.
 */

import { and, eq, sql } from "drizzle-orm";

import type { RequestContext } from "@platform/core";

import { issues } from "../schema/tenancy.js";
import { scoped } from "../scope.js";
import type { Db } from "../client.js";

/** The board hot path — covered by `issues_board_idx`. */
export async function listIssues(ctx: RequestContext, db: Db) {
  return db
    .select()
    .from(issues)
    .where(
      scoped(issues.workspaceId, ctx, {
        projectColumn: issues.projectId,
        deletedAtColumn: issues.deletedAt,
      }),
    )
    .orderBy(issues.rank);
}

export async function getIssue(ctx: RequestContext, db: Db, id: string) {
  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        scoped(issues.workspaceId, ctx, {
          projectColumn: issues.projectId,
          deletedAtColumn: issues.deletedAt,
        }),
        eq(issues.id, id),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listIssuesByProject(
  ctx: RequestContext,
  db: Db,
  projectId: string,
) {
  return db
    .select()
    .from(issues)
    .where(
      and(
        scoped(issues.workspaceId, ctx, {
          projectColumn: issues.projectId,
          deletedAtColumn: issues.deletedAt,
        }),
        eq(issues.projectId, projectId),
      ),
    )
    .orderBy(issues.rank);
}

export async function setIssueStatus(
  ctx: RequestContext,
  db: Db,
  id: string,
  status: string,
) {
  return db
    .update(issues)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        scoped(issues.workspaceId, ctx, {
          projectColumn: issues.projectId,
          deletedAtColumn: issues.deletedAt,
        }),
        eq(issues.id, id),
      ),
    )
    .returning();
}

export async function softDeleteIssue(ctx: RequestContext, db: Db, id: string) {
  return db
    .update(issues)
    .set({ deletedAt: new Date() })
    .where(
      and(
        scoped(issues.workspaceId, ctx, {
          projectColumn: issues.projectId,
          deletedAtColumn: issues.deletedAt,
        }),
        eq(issues.id, id),
      ),
    )
    .returning();
}
