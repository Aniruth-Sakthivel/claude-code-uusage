/**
 * Workspace membership repository.
 *
 * Workspace-level, so no `projectColumn` — a member is not scoped to a project.
 * Still workspace-scoped, which is the part that matters.
 */

import { and, eq } from "drizzle-orm";

import type { RequestContext } from "@platform/core";

import { users, workspaceMembers } from "../schema/tenancy.js";
import { scoped } from "../scope.js";
import type { Db } from "../client.js";

export async function listMembers(ctx: RequestContext, db: Db) {
  return db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      email: users.email,
      fullName: users.fullName,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(scoped(workspaceMembers.workspaceId, ctx));
}

export async function getMember(ctx: RequestContext, db: Db, userId: string) {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        scoped(workspaceMembers.workspaceId, ctx),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function setMemberRole(
  ctx: RequestContext,
  db: Db,
  userId: string,
  role: string,
) {
  return db
    .update(workspaceMembers)
    .set({ role })
    .where(
      and(
        scoped(workspaceMembers.workspaceId, ctx),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .returning();
}

export async function removeMember(ctx: RequestContext, db: Db, userId: string) {
  return db
    .delete(workspaceMembers)
    .where(
      and(
        scoped(workspaceMembers.workspaceId, ctx),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .returning();
}
