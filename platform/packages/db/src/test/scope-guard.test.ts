/**
 * Proof that the poison-row suite actually catches a missing predicate.
 *
 * Phase 0 exit requires this. A guard nobody has watched fail is not a guard —
 * it is a comment that happens to compile. So rather than asking a human to
 * temporarily delete a `workspace_id` predicate and eyeball CI, the deliberately
 * broken repository lives here permanently, and we assert that it leaks.
 *
 * If someone weakens `scoped()` so that unscoped and scoped queries behave the
 * same, THIS test fails — because the broken query stops leaking.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { __unsafeCreateRequestContext } from "@platform/core";

import { issues, projects } from "../schema/tenancy.js";
import { scopeProjects, scopeWorkspace, scoped } from "../scope.js";
import { listProjects } from "../repositories/projects.js";
import { principalFor, seed, type Seeded } from "./harness.js";

let world: Seeded;

beforeAll(async () => {
  world = await seed();
});

afterAll(async () => {
  await world?.close();
});

// ── the deliberately broken repository ───────────────────────────────────────
// This is what a repository function looks like when someone forgets the guard.
// It exists only in this file, and is never exported from the barrel.

async function listProjectsWITHOUTGuard(db: Seeded["db"]) {
  return db.select().from(projects);
}

async function listIssuesWithProjectScopeOnly(
  db: Seeded["db"],
  ctx: ReturnType<typeof principalFor>,
) {
  // Scopes projects but forgets the workspace — the subtler mistake, and the
  // one code review misses, because it *looks* scoped.
  return db.select().from(issues).where(scopeProjects(issues.projectId, ctx));
}

describe("the detector catches what it is supposed to catch", () => {
  it("an unscoped query DOES leak the other workspace", async () => {
    const leaked = await listProjectsWITHOUTGuard(world.db);
    const ids = leaked.map((r) => r.id);

    expect(ids).toContain(world.A.projectId);
    expect(ids).toContain(world.B.projectId); // <- the leak
    expect(leaked).toHaveLength(2);
  });

  it("the correctly-scoped equivalent does not", async () => {
    const ctx = principalFor(world.A);
    const rows = await listProjects(ctx, world.db);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(world.A.projectId);
    expect(ids).not.toContain(world.B.projectId);
    expect(rows).toHaveLength(1);
  });

  it("scoping projects but forgetting the workspace leaks EVERYTHING for a privileged role", async () => {
    // The subtle one, and the reason `scopeWorkspace` has no null escape hatch.
    //
    // This query *looks* scoped — it calls a scope helper. But an admin holds
    // `view_all_projects`, so `projectScope` is null and `scopeProjects`
    // correctly returns TRUE. With no workspace predicate underneath it, the
    // filter collapses to nothing and every workspace comes back.
    //
    // Code review reads "scopeProjects(...)" and moves on. This is exactly the
    // shape that ships.
    const ctx = principalFor(world.A, "admin");
    expect(ctx.projectScope).toBeNull();

    const leaked = await listIssuesWithProjectScopeOnly(world.db, ctx);
    const workspaces = new Set(leaked.map((r) => r.workspaceId));

    expect(workspaces).toContain(world.A.workspaceId);
    expect(workspaces).toContain(world.B.workspaceId); // <- the leak
    expect(leaked).toHaveLength(2);
  });

  it("the same query with the workspace guard returns only the caller's workspace", async () => {
    const ctx = principalFor(world.A, "admin");
    const rows = await world.db
      .select()
      .from(issues)
      .where(scoped(issues.workspaceId, ctx, { projectColumn: issues.projectId }));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(world.A.workspaceId);
  });

  it("the guarded fragment is strictly stronger than the project-only one", () => {
    const ctx = principalFor(world.A, "admin");
    const withGuard = scoped(issues.workspaceId, ctx, { projectColumn: issues.projectId });
    const withoutGuard = scopeProjects(issues.projectId, ctx);
    expect(withGuard.queryChunks.length).toBeGreaterThan(withoutGuard.queryChunks.length);
  });
});

describe("scopeProjects — the three-valued contract", () => {
  it("null scope means no filter", async () => {
    const ctx = __unsafeCreateRequestContext({
      userId: world.A.userId,
      role: "admin", // view_all_projects → null scope
      workspaceId: world.A.workspaceId,
      projectIds: [],
    });
    expect(ctx.projectScope).toBeNull();

    const rows = await world.db
      .select()
      .from(projects)
      .where(and(scopeWorkspace(projects.workspaceId, ctx), scopeProjects(projects.id, ctx)));
    expect(rows).toHaveLength(1); // A's project, unfiltered by grant
  });

  it("EMPTY scope means zero rows — never all rows", async () => {
    const ctx = __unsafeCreateRequestContext({
      userId: world.A.userId,
      role: "contributor",
      workspaceId: world.A.workspaceId,
      projectIds: [],
    });

    const rows = await world.db
      .select()
      .from(projects)
      .where(and(scopeWorkspace(projects.workspaceId, ctx), scopeProjects(projects.id, ctx)));

    expect(rows).toEqual([]);
  });

  it("an explicit grant returns exactly that project", async () => {
    const ctx = principalFor(world.A, "contributor");
    const rows = await world.db
      .select()
      .from(projects)
      .where(and(scopeWorkspace(projects.workspaceId, ctx), scopeProjects(projects.id, ctx)));

    expect(rows.map((r) => r.id)).toEqual([world.A.projectId]);
  });
});

describe("soft delete is excluded by default", () => {
  it("hides a trashed row, and includeDeleted brings it back", async () => {
    const ctx = principalFor(world.A);

    await world.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, world.A.projectId));

    const visible = await world.db
      .select()
      .from(projects)
      .where(scoped(projects.workspaceId, ctx, { deletedAtColumn: projects.deletedAt }));
    expect(visible).toEqual([]);

    const withTrash = await world.db
      .select()
      .from(projects)
      .where(
        scoped(projects.workspaceId, ctx, {
          deletedAtColumn: projects.deletedAt,
          includeDeleted: true,
        }),
      );
    expect(withTrash).toHaveLength(1);

    await world.db
      .update(projects)
      .set({ deletedAt: null })
      .where(eq(projects.id, world.A.projectId));
  });
});
