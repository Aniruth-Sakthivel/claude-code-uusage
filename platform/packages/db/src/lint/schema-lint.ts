/**
 * Structural invariants, checked against the Drizzle schema at build time.
 *
 * These catch the mistakes that are invisible in review because they are
 * omissions rather than errors: a new table that quietly has no tenant column,
 * an index that scans cross-tenant before filtering, a unique constraint that
 * permanently blocks slug reuse after a delete.
 */

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

/**
 * Tables that legitimately have no `workspace_id`.
 *
 * Reviewed quarterly. Adding to it requires a written justification in the PR,
 * because every entry is a table the tenancy guard cannot protect.
 */
export const GLOBAL_TABLES = new Set([
  "organizations", // the org itself
  "workspaces", // the scope boundary cannot be scoped by itself
  "users", // a user spans workspaces
  "feature_flags",
  "app_settings",
]);

export interface LintFinding {
  table: string;
  rule: string;
  detail: string;
}

export function lintSchema(tables: Record<string, unknown>): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const value of Object.values(tables)) {
    if (!isPgTable(value)) continue;
    const config = getTableConfig(value as PgTable);
    const name = config.name;

    const columns = new Set(config.columns.map((c) => c.name));
    const isGlobal = GLOBAL_TABLES.has(name);
    const hasWorkspace = columns.has("workspace_id");

    // 1. Every table is tenanted, or explicitly exempted.
    if (!isGlobal && !hasWorkspace) {
      findings.push({
        table: name,
        rule: "workspace-id-required",
        detail:
          "no workspace_id column and not in GLOBAL_TABLES. A new table must " +
          "be tenanted, or exempted deliberately with a written justification.",
      });
    }

    // 2. An exempted table must not carry workspace_id — that would mean the
    //    exemption is stale and the table is really tenanted after all.
    if (isGlobal && hasWorkspace) {
      findings.push({
        table: name,
        rule: "stale-global-exemption",
        detail: "is in GLOBAL_TABLES but has a workspace_id column. Remove the exemption.",
      });
    }

    const softDeletable = columns.has("deleted_at");

    for (const index of config.indexes) {
      const cfg = index.config;
      const first = cfg.columns[0];
      const firstName =
        first && "name" in first ? (first as { name: string }).name : undefined;

      // 3. Composite indexes on tenant tables lead with workspace_id, so the
      //    planner narrows to one tenant before doing anything else.
      if (
        hasWorkspace &&
        cfg.columns.length > 1 &&
        firstName !== "workspace_id" &&
        !cfg.unique
      ) {
        findings.push({
          table: name,
          rule: "index-leads-with-workspace-id",
          detail: `index "${cfg.name}" starts with "${firstName ?? "?"}" instead of workspace_id.`,
        });
      }

      // 4. Unique indexes on soft-deletable tables must be partial, or a
      //    deleted row's slug/key can never be reused.
      if (cfg.unique && softDeletable && !cfg.where) {
        findings.push({
          table: name,
          rule: "partial-unique-on-soft-delete",
          detail:
            `unique index "${cfg.name}" has no WHERE clause. It must be ` +
            "partial (WHERE deleted_at IS NULL) or a deleted row blocks reuse of its key forever.",
        });
      }
    }
  }

  return findings;
}

function isPgTable(value: unknown): value is PgTable {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getOwnPropertySymbols(value).some((s) => s.toString().includes("drizzle:Name"))
  );
}

export function formatFindings(findings: LintFinding[]): string {
  if (findings.length === 0) return "schema lint: clean";
  return [
    `schema lint: ${findings.length} finding(s)`,
    ...findings.map((f) => `  [${f.rule}] ${f.table}: ${f.detail}`),
  ].join("\n");
}
