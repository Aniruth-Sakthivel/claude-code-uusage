/**
 * Tenancy tables — the scope boundary everything else lives inside.
 *
 * `organizations` exists now with exactly one row, and **only `workspaces`
 * carries `organization_id`**. That is deliberate: scope resolution is
 * `principal → workspace_members → workspaceId`, so introducing real
 * multi-organization support later means adding a predicate to that one
 * resolution step rather than a column to two hundred tables.
 *
 * Every other table in the system carries `workspace_id NOT NULL`, or appears
 * in the `GLOBAL_TABLES` allowlist in `../lint/schema-lint.ts`. The lint fails
 * the build otherwise.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** GLOBAL — one row today; exists so orgs are a future migration, not a rewrite. */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** GLOBAL — the scope boundary itself, so it cannot be scoped by one. */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    accentColor: varchar("accent_color", { length: 16 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // Partial, so the slug of a deleted workspace can be reused. Every unique
    // index on a soft-deletable table must be partial for this reason; the
    // schema lint enforces it.
    uniqueIndex("workspaces_slug_idx").on(t.slug).where(sql`deleted_at is null`),
    index("workspaces_org_idx").on(t.organizationId),
  ],
);

/** GLOBAL — a user spans workspaces, so this row cannot belong to one. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  supabaseUserId: uuid("supabase_user_id").unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  fullName: varchar("full_name", { length: 200 }).notNull().default(""),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The scope resolution table. `RequestContext.workspaceId` comes from here and
 * nowhere else — never from the URL, which is input rather than authority.
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 32 }).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 12 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    leadUserId: uuid("lead_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Optimistic concurrency. Bumped on every write; drives `If-Match`. */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("projects_key_idx")
      .on(t.workspaceId, t.key)
      .where(sql`deleted_at is null`),
    index("projects_workspace_idx").on(t.workspaceId, t.createdAt),
  ],
);

export const projectMembers = pgTable(
  "project_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index("project_members_workspace_idx").on(t.workspaceId, t.userId),
  ],
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 24 }).notNull(),
    type: varchar("type", { length: 16 }).notNull().default("task"),
    title: varchar("title", { length: 300 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("todo"),
    priority: varchar("priority", { length: 16 }).notNull().default("medium"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** LexoRank. A drag is one single-row UPDATE computing a midpoint string. */
    rank: varchar("rank", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("issues_key_idx")
      .on(t.workspaceId, t.key)
      .where(sql`deleted_at is null`),
    // The board hot path. Leads with workspace_id, as every composite index
    // must; the lint checks it.
    index("issues_board_idx").on(t.workspaceId, t.projectId, t.status, t.rank),
    index("issues_assignee_idx").on(t.workspaceId, t.assigneeUserId, t.status),
  ],
);
