/**
 * The scope guard.
 *
 * Every query in the system passes through here. It is the security boundary —
 * not the route handler, not the service, not code review.
 *
 * Two dimensions:
 *
 *   workspace — unconditional. There is no "all workspaces" mode and no null
 *               escape hatch. A caller that wants cross-workspace data uses
 *               `unsafeCrossWorkspace()` in `./admin`, which is logged and
 *               confined to admin tooling.
 *
 *   project   — three-valued, ported from the previous system's `scope.ts`:
 *                 null → no filter (a `view_all_projects` role)
 *                 []   → sql`false`. ZERO rows. Never all rows
 *                 [..] → inArray
 *
 * The empty-array case is the entire reason this file exists. `inArray(col, [])`
 * generates SQL that Postgres evaluates as false in some drivers and errors on
 * in others, and a hand-written `if (ids.length) query.where(...)` silently
 * drops the filter — turning a permission failure into a full workspace dump.
 * We make it explicit and we test it.
 */

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import type { RequestContext } from "@platform/core";

/** Always true, as a SQL fragment. */
const TRUE: SQL = sql`true`;

/** Always false. The fail-closed value. */
const FALSE: SQL = sql`false`;

/**
 * Restrict to the caller's workspace. Unconditional, by design.
 */
export function scopeWorkspace(column: PgColumn, ctx: RequestContext): SQL {
  return eq(column, ctx.workspaceId);
}

/**
 * Restrict to the projects the caller may read.
 *
 * @param column the `project_id` column on the table being queried
 */
export function scopeProjects(column: PgColumn, ctx: RequestContext): SQL {
  const allowed = ctx.projectScope;
  if (allowed === null) return TRUE; // sees every project in the workspace
  if (allowed.length === 0) return FALSE; // sees none — MUST be zero rows
  return inArray(column, allowed as string[]);
}

export interface ScopeOptions {
  /**
   * The table's `project_id` column, when it has one. Omit for tables that are
   * workspace-level rather than project-level (labels, channels, members).
   */
  projectColumn?: PgColumn;
  /**
   * The table's `deleted_at` column. When present, soft-deleted rows are
   * excluded unless `includeDeleted` is set.
   */
  deletedAtColumn?: PgColumn;
  /** Opt in to trash. Used by restore flows and the retention purge only. */
  includeDeleted?: boolean;
}

/**
 * The one call every repository read makes.
 *
 *   const rows = await db.select().from(issues)
 *     .where(and(scoped(issues.workspaceId, ctx, {
 *       projectColumn: issues.projectId,
 *       deletedAtColumn: issues.deletedAt,
 *     }), eq(issues.status, "todo")));
 */
export function scoped(
  workspaceColumn: PgColumn,
  ctx: RequestContext,
  options: ScopeOptions = {},
): SQL {
  const parts: SQL[] = [scopeWorkspace(workspaceColumn, ctx)];

  if (options.projectColumn) {
    parts.push(scopeProjects(options.projectColumn, ctx));
  }

  if (options.deletedAtColumn && !options.includeDeleted) {
    parts.push(isNull(options.deletedAtColumn));
  }

  // `and` of a single element is that element; of several, the conjunction.
  return parts.length === 1 ? parts[0]! : (and(...parts) as SQL);
}
