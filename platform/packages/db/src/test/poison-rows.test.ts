/**
 * THE POISON-ROW SUITE.
 *
 * The single most important test in the system. Everything else about the
 * tenancy design — the branded context, the `scoped()` builder, the schema
 * lint — is ergonomics. This is the guarantee.
 *
 *   1. Seed workspace A and workspace B, each with a row in every tenant table
 *   2. Enumerate every exported repository function BY REFLECTION
 *   3. Invoke each as a workspace-A principal, with arguments that name B's rows
 *   4. Assert: zero B rows returned. Zero B rows mutated. Zero B rows deleted.
 *
 * Reflection is what makes it durable: a repository function added next year is
 * covered without anyone remembering to write a test for it.
 *
 * Phase 0 exit requires proving this fails — see `scope-guard.test.ts`, which
 * removes the predicate and asserts leakage is detected. An untested guard is
 * not a guard, it is a comment.
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as repositories from "../repositories/index.js";
import { principalFor, seed, type Seeded } from "./harness.js";

let world: Seeded;

beforeAll(async () => {
  world = await seed();
});

afterAll(async () => {
  await world?.close();
});

/** Every exported function across every repository module, flattened. */
function enumerateRepositoryFunctions(): Array<{
  module: string;
  name: string;
  fn: (...args: unknown[]) => unknown;
}> {
  const out: Array<{ module: string; name: string; fn: (...args: unknown[]) => unknown }> = [];
  for (const [moduleName, mod] of Object.entries(repositories)) {
    for (const [fnName, value] of Object.entries(mod as Record<string, unknown>)) {
      if (typeof value === "function") {
        out.push({
          module: moduleName,
          name: fnName,
          fn: value as (...args: unknown[]) => unknown,
        });
      }
    }
  }
  return out;
}

/**
 * Argument candidates for a reflected call.
 *
 * Every id belongs to workspace B. A correctly-scoped function returns nothing
 * for all of them; an unscoped one hands back B's data.
 */
function foreignArguments(): unknown[][] {
  const B = world.B;
  return [
    [],
    [B.projectId],
    [B.issueId],
    [B.userId],
    [B.workspaceId],
    [B.projectId, "leaked"],
    [B.issueId, "done"],
    [B.userId, "admin"],
  ];
}

/** Snapshot of every id in every tenant table, for mutation detection. */
async function snapshot(): Promise<Record<string, string>> {
  const tables = [
    "workspaces",
    "users",
    "workspace_members",
    "projects",
    "project_members",
    "issues",
  ];
  const out: Record<string, string> = {};
  for (const table of tables) {
    const result = (await world.db.execute(
      sql.raw(`select md5(string_agg(t::text, '|' order by t::text)) as digest from ${table} t`),
    )) as { rows?: Array<{ digest: string | null }> };
    out[table] = result.rows?.[0]?.digest ?? "";
  }
  return out;
}

/** Does a returned value contain any id belonging to workspace B? */
function containsForeignData(value: unknown): string | null {
  const foreign = new Set(Object.values(world.B.rowIds).flat());
  const seen = new Set<unknown>();

  const walk = (node: unknown): string | null => {
    if (node === null || node === undefined) return null;
    if (typeof node === "string") return foreign.has(node) ? node : null;
    if (typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };

  return walk(value);
}

describe("poison rows — workspace A must never reach workspace B", () => {
  const functions = enumerateRepositoryFunctions();

  it("found repository functions to test", () => {
    // Guards against the suite silently passing because reflection broke.
    expect(functions.length).toBeGreaterThan(0);
  });

  it("covers every repository module in the barrel", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "repositories");
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .map((f) => f.replace(/\.ts$/, ""));
    const exported = Object.keys(repositories);
    // A module not re-exported from the barrel is invisible to this suite,
    // which would be a silent hole rather than a failure.
    expect([...exported].sort()).toEqual([...onDisk].sort());
  });

  for (const { module, name, fn } of functions) {
    it(`${module}.${name} leaks nothing to a foreign principal`, async () => {
      const ctx = principalFor(world.A);
      const before = await snapshot();

      let calls = 0;
      for (const args of foreignArguments()) {
        let result: unknown;
        try {
          result = await fn(ctx, world.db, ...args);
        } catch {
          // An arity or type mismatch for this argument shape is fine — the
          // call simply does not apply. A *scoping* failure cannot hide here,
          // because a throw returns no data and mutates nothing.
          continue;
        }
        calls++;

        const leaked = containsForeignData(result);
        expect(
          leaked,
          `${module}.${name}(${args.map(String).join(", ")}) returned workspace B data: ${leaked}`,
        ).toBeNull();
      }

      expect(calls, `${module}.${name} was never successfully invoked`).toBeGreaterThan(0);

      const after = await snapshot();
      expect(
        after,
        `${module}.${name} mutated rows while scoped to another workspace`,
      ).toEqual(before);
    });
  }
});

describe("poison rows — an empty project scope yields nothing, not everything", () => {
  it("returns zero rows for a principal with no project grants", async () => {
    const { __unsafeCreateRequestContext } = await import("@platform/core");
    const ctx = __unsafeCreateRequestContext({
      userId: world.A.userId,
      role: "contributor", // no view_all_projects
      workspaceId: world.A.workspaceId,
      projectIds: [], // <- the case that matters
    });

    const projects = await repositories.projects.listProjects(ctx, world.db);
    const issues = await repositories.issues.listIssues(ctx, world.db);

    // If the guard ever treats "no scope" as "no filter", these return the
    // whole workspace and this assertion is the thing that catches it.
    expect(projects).toEqual([]);
    expect(issues).toEqual([]);
  });

  it("still returns the caller's own rows when a grant exists", async () => {
    const ctx = principalFor(world.A);
    const projects = await repositories.projects.listProjects(ctx, world.db);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(world.A.projectId);
  });
});
