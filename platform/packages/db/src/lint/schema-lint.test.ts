import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import * as schema from "../schema/tenancy.js";
import { lintSchema } from "./schema-lint.js";

describe("the real schema", () => {
  it("passes every structural invariant", () => {
    const findings = lintSchema(schema as unknown as Record<string, unknown>);
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
});

describe("the lint catches what it is supposed to catch", () => {
  it("flags a new table with no workspace_id", () => {
    const orphan = pgTable("comments", {
      id: uuid("id").primaryKey(),
      body: varchar("body", { length: 200 }).notNull(),
    });

    const findings = lintSchema({ orphan });
    expect(findings.map((f) => f.rule)).toContain("workspace-id-required");
  });

  it("flags a composite index that does not lead with workspace_id", () => {
    const bad = pgTable(
      "widgets",
      {
        id: uuid("id").primaryKey(),
        workspaceId: uuid("workspace_id").notNull(),
        status: varchar("status", { length: 16 }).notNull(),
      },
      (t) => [index("widgets_bad_idx").on(t.status, t.workspaceId)],
    );

    const findings = lintSchema({ bad });
    expect(findings.map((f) => f.rule)).toContain("index-leads-with-workspace-id");
  });

  it("flags a non-partial unique index on a soft-deletable table", () => {
    const bad = pgTable(
      "gadgets",
      {
        id: uuid("id").primaryKey(),
        workspaceId: uuid("workspace_id").notNull(),
        slug: varchar("slug", { length: 40 }).notNull(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
      },
      (t) => [uniqueIndex("gadgets_slug_idx").on(t.workspaceId, t.slug)],
    );

    const findings = lintSchema({ bad });
    expect(findings.map((f) => f.rule)).toContain("partial-unique-on-soft-delete");
  });

  it("accepts the same unique index once it is partial", () => {
    const good = pgTable(
      "gadgets",
      {
        id: uuid("id").primaryKey(),
        workspaceId: uuid("workspace_id").notNull(),
        slug: varchar("slug", { length: 40 }).notNull(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
      },
      (t) => [
        uniqueIndex("gadgets_slug_idx")
          .on(t.workspaceId, t.slug)
          .where(sql`deleted_at is null`),
      ],
    );

    expect(lintSchema({ good })).toEqual([]);
  });

  it("flags a stale GLOBAL_TABLES exemption", () => {
    const stale = pgTable("users", {
      id: uuid("id").primaryKey(),
      workspaceId: uuid("workspace_id").notNull(),
    });

    const findings = lintSchema({ stale });
    expect(findings.map((f) => f.rule)).toContain("stale-global-exemption");
  });
});
