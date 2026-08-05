/**
 * Meterhouse central data model (Drizzle / Postgres).
 *
 * Ported from the Python SQLAlchemy models with three structural additions:
 *   - `dailyAggregates` — rollup so dashboards don't full-scan `usage_events`.
 *   - `enrollTokens`    — single-use, short-lived tokens for one-click PC connect.
 *   - covering indexes on the columns every dashboard query filters by.
 *
 * Two independent auth principals live here:
 *   - `users`    — humans who sign into the dashboard (Supabase Auth JWT).
 *   - `apiKeys`  — per-PC agent credentials (`cfk_` bearer keys, sha256 at rest).
 * Neither is ever accepted where the other belongs.
 *
 * Privacy invariant: only token counts and metadata are stored. Never prompts,
 * responses, or source code.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ── roles ────────────────────────────────────────────────────────────────────
export const roles = pgTable("roles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 32 }).notNull().unique(), // admin/manager/developer/viewer
  description: varchar("description", { length: 200 }).notNull().default(""),
});

// ── users ────────────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    fullName: varchar("full_name", { length: 120 }).notNull().default(""),
    // Supabase Auth owns credentials; this is the link to that identity.
    supabaseUserId: varchar("supabase_user_id", { length: 64 }).unique(),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_supabase_uid_idx").on(t.supabaseUserId)],
);

// ── systems (one row per PC) ──────────────────────────────────────────────────
export const systems = pgTable(
  "systems",
  {
    systemId: varchar("system_id", { length: 64 }).primaryKey(), // UUID
    displayName: varchar("display_name", { length: 120 }).notNull(),
    hostname: varchar("hostname", { length: 255 }).notNull().default(""),
    agentVersion: varchar("agent_version", { length: 32 }).notNull().default(""),

    // Descriptive metadata set at enrollment.
    owner: varchar("owner", { length: 120 }).notNull().default(""),
    location: varchar("location", { length: 120 }).notNull().default(""),
    environment: varchar("environment", { length: 40 }).notNull().default(""),
    notes: text("notes").notNull().default(""),

    // Who enrolled this PC — lets a non-admin see the machines they connected.
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Liveness + real agent status (NEW: the Python model had only lastSeenAt,
    // so the UI could not distinguish "never scanned" from "scanned long ago").
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    totalEvents: bigint("total_events", { mode: "number" }).notNull().default(0),

    /**
     * What the agent is doing right now, as it reports it: idle | scanning |
     * scanned | syncing | paused. `lastSeenAt` alone could only say "something
     * checked in recently", which is not enough to answer the question an
     * admin actually asks — is this machine's agent working?
     *
     * `agentStatusAt` is when the agent said so, not when we noticed: a
     * "scanning" that stopped updating is how a hung agent shows up.
     */
    agentStatus: varchar("agent_status", { length: 16 }).notNull().default(""),
    agentStatusAt: timestamp("agent_status_at", { withTimezone: true }),
    agentStatusDetail: varchar("agent_status_detail", { length: 255 }).notNull().default(""),
    /** The agent's own scan cadence — what the next-scan countdown counts down to. */
    scanIntervalSeconds: integer("scan_interval_seconds"),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    lastScanDurationMs: integer("last_scan_duration_ms"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("systems_created_by_idx").on(t.createdByUserId)],
);

// ── developer → system assignments (RBAC scoping) ─────────────────────────────
export const userSystems = pgTable(
  "user_systems",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.systemId] }),
    index("user_systems_system_idx").on(t.systemId),
  ],
);

// ── agent API keys ────────────────────────────────────────────────────────────
export const apiKeys = pgTable(
  "api_keys",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull().default(""),
    prefix: varchar("prefix", { length: 16 }).notNull(), // shown in the UI
    keyHash: varchar("key_hash", { length: 128 }).notNull(), // sha256 of the full key
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    // Every agent request hashes its bearer token and looks it up here.
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_system_idx").on(t.systemId),
  ],
);

// ── usage events (the single source of truth) ─────────────────────────────────
export const usageEvents = pgTable(
  "usage_events",
  {
    // event_id = "<system_id>:<suffix>" — globally unique across the fleet, so
    // re-scanning or re-syncing the same turn can never double-count.
    eventId: varchar("event_id", { length: 128 }).primaryKey(),
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    projectName: varchar("project_name", { length: 255 }).notNull().default("unknown"),

    tsUtc: varchar("ts_utc", { length: 40 }).notNull(), // ISO-8601, always UTC
    day: varchar("day", { length: 10 }).notNull(), // YYYY-MM-DD, UTC bucket

    model: varchar("model", { length: 80 }).notNull().default(""),
    modelFamily: varchar("model_family", { length: 24 }).notNull().default("unknown"),

    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),

    toolName: varchar("tool_name", { length: 80 }),
    isSubagent: integer("is_subagent").notNull().default(0),
    agentId: varchar("agent_id", { length: 64 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Dashboard queries always filter by system and day; this covering index
    // turns the old full-table aggregate scans into index scans.
    index("usage_events_system_day_idx").on(t.systemId, t.day),
    index("usage_events_system_day_tokens_idx").on(t.systemId, t.day, t.totalTokens),
    index("usage_events_day_idx").on(t.day),
    index("usage_events_project_idx").on(t.systemId, t.projectName),
    index("usage_events_session_idx").on(t.systemId, t.sessionId),
  ],
);

// ── daily rollup (NEW) ────────────────────────────────────────────────────────
/**
 * Pre-aggregated (system, day, model family) totals, upserted inside the same
 * transaction as ingest so it can never drift from `usage_events`.
 *
 * The Python dashboard ran six full-table aggregates per page load. This table
 * keeps that cost flat as the event count grows.
 */
export const dailyAggregates = pgTable(
  "daily_aggregates",
  {
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    day: varchar("day", { length: 10 }).notNull(),
    modelFamily: varchar("model_family", { length: 24 }).notNull().default("unknown"),

    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" })
      .notNull()
      .default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.systemId, t.day, t.modelFamily] }),
    index("daily_aggregates_day_idx").on(t.day),
  ],
);

// ── enrollment tokens (NEW — powers one-click connect) ────────────────────────
/**
 * Short-lived, single-use token embedded in the install-script URL.
 *
 * The script URL is pasted into a terminal and lands in shell history, so it
 * must never contain the real `cfk_` key. Instead it carries this token, which
 * the server exchanges for the key exactly once, within 15 minutes.
 */
export const enrollTokens = pgTable(
  "enroll_tokens",
  {
    token: varchar("token", { length: 64 }).primaryKey(),
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    apiKeyId: integer("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    // The plaintext key, held only until the token is consumed or expires.
    apiKeyPlain: varchar("api_key_plain", { length: 128 }).notNull(),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    displayName: varchar("display_name", { length: 120 }).notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enroll_tokens_expires_idx").on(t.expiresAt)],
);

// ── agent commands (fleet management) ─────────────────────────────────────────
/**
 * A command an operator queued for one PC's agent.
 *
 * Durable rather than fire-and-forget over the socket: the WS server and the
 * REST API are separate processes (see ws/server.ts), and the agent itself
 * may be offline or running in REST-only mode. So this table is the single
 * source of truth for "what does this agent still need to do" — both the WS
 * server (on heartbeat/scan_result) and the REST heartbeat/sync/register
 * routes read pending rows for the calling system and hand them to the
 * agent, which then acks by id. A command left `pending` simply gets handed
 * out again next time that system checks in.
 */
export const agentCommands = pgTable(
  "agent_commands",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    action: varchar("action", { length: 32 }).notNull(), // scan_now | pause | resume | set_config
    payload: text("payload").notNull().default("{}"), // JSON, shape depends on action
    status: varchar("status", { length: 16 }).notNull().default("pending"), // pending | acked | failed
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    ackDetail: text("ack_detail").notNull().default(""),
  },
  (t) => [
    // Every check-in queries "pending commands for this system" — the hot path.
    index("agent_commands_system_status_idx").on(t.systemId, t.status),
  ],
);

// ── initiatives (project management) ──────────────────────────────────────────
/**
 * Internal PM module: Initiative -> Milestone / Task -> Comment, plus Docs and
 * an Activity feed. Deliberately never called "project" — that word is already
 * the usage-tracking dimension (`usageEvents.projectName`, a folder-name label
 * with no PM semantics); "Initiative" avoids colliding with it in the same nav.
 *
 * Open to every signed-in user (no capability gate, single org) — see
 * services/pm.ts. `createdByUserId`/`authorUserId`/`actorUserId` all
 * `onDelete: "set null"`, matching `systems.createdByUserId` and
 * `agentCommands.createdByUserId`: removing a user must never cascade-delete
 * their initiatives, tasks, or comments.
 */
export const initiatives = pgTable(
  "initiatives",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description").notNull().default(""), // markdown
    status: varchar("status", { length: 16 }).notNull().default("active"), // active | on_hold | completed | archived
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("initiatives_status_idx").on(t.status),
    index("initiatives_created_at_idx").on(t.createdAt),
  ],
);

export const milestones = pgTable(
  "milestones",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    dueDate: varchar("due_date", { length: 10 }), // YYYY-MM-DD, nullable — mirrors promptDaily.day
    status: varchar("status", { length: 16 }).notNull().default("open"), // open | done
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("milestones_initiative_idx").on(t.initiativeId)],
);

// ── epics ────────────────────────────────────────────────────────────────────
/** Groups related tasks within an initiative — one level above Task, same
 * relationship a milestone has to tasks but purely organizational (no due
 * date/deadline semantics of its own). */
export const epics = pgTable(
  "epics",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    description: text("description").notNull().default(""),
    color: varchar("color", { length: 16 }).notNull().default("#6366f1"),
    status: varchar("status", { length: 16 }).notNull().default("open"), // open | done
    createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("epics_initiative_idx").on(t.initiativeId)],
);

// ── sprints ──────────────────────────────────────────────────────────────────
/** Time-boxed pulls from the backlog. A task with `sprintId IS NULL` is in
 * the backlog; setting one moves it onto that sprint without touching its
 * board `status`, which stays the source of truth for the kanban column. */
export const sprints = pgTable(
  "sprints",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    startDate: varchar("start_date", { length: 10 }), // YYYY-MM-DD, nullable
    endDate: varchar("end_date", { length: 10 }),
    status: varchar("status", { length: 16 }).notNull().default("planned"), // planned | active | completed
    createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sprints_initiative_idx").on(t.initiativeId)],
);

// ── board columns (custom workflow) ────────────────────────────────────────────
/**
 * Per-initiative status columns. Every initiative gets the three default
 * columns (todo/in_progress/done) seeded at creation — see
 * services/pm.ts `createInitiative` — but can add/rename/reorder/remove from
 * there. `tasks.status` stores a column `key`, validated at the service
 * layer against this table instead of a fixed Zod enum (the extensibility
 * path already called out when the board was first built).
 */
export const boardColumns = pgTable(
  "board_columns",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 32 }).notNull(),
    label: varchar("label", { length: 60 }).notNull(),
    position: integer("position").notNull().default(0),
    isDoneColumn: boolean("is_done_column").notNull().default(false), // drives "open task" counts/reports
  },
  (t) => [
    uniqueIndex("board_columns_initiative_key_idx").on(t.initiativeId, t.key),
    index("board_columns_initiative_position_idx").on(t.initiativeId, t.position),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    // Deliberate asymmetry vs. initiativeId: deleting a milestone unlinks its
    // tasks rather than deleting them — a milestone is an organizational
    // sub-grouping, not an ownership boundary.
    milestoneId: integer("milestone_id").references(() => milestones.id, {
      onDelete: "set null",
    }),
    epicId: integer("epic_id").references(() => epics.id, { onDelete: "set null" }),
    sprintId: integer("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    // Subtask parent — nullable self-reference. `AnyPgColumn` return type is
    // required by Drizzle for self-referencing FKs (the column being defined
    // can't be named directly inside its own table's definition).
    parentTaskId: integer("parent_task_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "set null",
    }),
    title: varchar("title", { length: 300 }).notNull(),
    description: text("description").notNull().default(""), // markdown
    status: varchar("status", { length: 32 }).notNull().default("todo"), // a board_columns.key for this initiative
    priority: varchar("priority", { length: 8 }).notNull().default("medium"), // low | medium | high | urgent
    storyPoints: integer("story_points"), // nullable — not every task is estimated
    assigneeUserId: integer("assignee_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dueDate: varchar("due_date", { length: 10 }), // YYYY-MM-DD, nullable
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Hot path: board view queries "tasks for this initiative, grouped by status".
    index("tasks_initiative_status_idx").on(t.initiativeId, t.status),
    index("tasks_milestone_idx").on(t.milestoneId),
    index("tasks_assignee_idx").on(t.assigneeUserId),
    index("tasks_epic_idx").on(t.epicId),
    index("tasks_sprint_idx").on(t.sprintId),
    index("tasks_parent_idx").on(t.parentTaskId),
  ],
);

// ── labels ───────────────────────────────────────────────────────────────────
/** Workspace-wide reusable tags (not per-initiative) — "bug", "frontend",
 * etc. mean the same thing across every project, same as Jira's global
 * label pool. */
export const labels = pgTable("labels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 60 }).notNull().unique(),
  color: varchar("color", { length: 16 }).notNull().default("#64748b"),
});

export const taskLabels = pgTable(
  "task_labels",
  {
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.labelId] }), index("task_labels_label_idx").on(t.labelId)],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorUserId: integer("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    authorEmail: varchar("author_email", { length: 255 }).notNull().default(""), // denormalized, matches auditLogs.actorEmail
    body: text("body").notNull(), // markdown
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("task_comments_task_idx").on(t.taskId, t.createdAt)],
);

export const docs = pgTable(
  "docs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // Nullable: a doc tied to an initiative is per-project documentation; a
    // doc with no initiative is a workspace-wide wiki page (see
    // routes/pm.ts `/workspace/docs`).
    initiativeId: integer("initiative_id").references(() => initiatives.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull().default(""), // markdown
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: integer("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("docs_initiative_idx").on(t.initiativeId)],
);

/**
 * Dedicated PM activity feed — deliberately not the existing `auditLogs`
 * table. `auditLogs` is a security/ops artifact for capability-gated admin
 * pages, keyed to a free-text `target`; this is a product surface shown to
 * every user per-initiative, needs structured `entityType`/`entityId` for
 * deep-linking, and would otherwise mix high-volume PM chatter into a
 * compliance-sensitive table.
 */
export const pmActivity = pgTable(
  "pm_activity",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: varchar("actor_email", { length: 255 }).notNull().default(""),
    // e.g. "initiative.created", "task.created", "task.status_changed",
    // "task.commented", "milestone.completed", "doc.updated"
    action: varchar("action", { length: 64 }).notNull(),
    // Polymorphic pointer to the entity the event is about, so the feed can
    // deep-link ("Task #42") without a join per row.
    entityType: varchar("entity_type", { length: 16 }).notNull(), // initiative | milestone | task | doc | comment
    entityId: integer("entity_id").notNull(),
    detail: text("detail").notNull().default(""), // short human string, e.g. "todo -> in_progress"
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Hot path: "activity feed for this initiative", newest first.
    index("pm_activity_initiative_at_idx").on(t.initiativeId, t.at),
  ],
);

// ── notifications ──────────────────────────────────────────────────────────────
/**
 * In-app notifications, one row per recipient per event. Unlike PM activity
 * (a per-initiative public feed), this is per-user and privately scoped —
 * `userId` cascades on delete (the notification is meaningless without its
 * owner), unlike the `set null` pattern used for authorship columns
 * elsewhere in this file.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 32 }).notNull(), // task_assigned | task_commented | chat_mention | ...
    title: varchar("title", { length: 300 }).notNull(),
    body: text("body").notNull().default(""),
    entityType: varchar("entity_type", { length: 16 }).notNull().default(""),
    entityId: integer("entity_id"),
    link: varchar("link", { length: 300 }).notNull().default(""), // relative frontend path
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Hot path: "unread notifications for this user", newest first.
    index("notifications_user_read_idx").on(t.userId, t.readAt, t.createdAt),
  ],
);

// ── team chat ──────────────────────────────────────────────────────────────────
/**
 * Channels (`kind: "channel"`) and 1:1 DMs (`kind: "dm"`, always exactly two
 * members, `name` left blank — the frontend derives the display name from
 * the other member) share one table rather than two, since messages/
 * membership are structurally identical for both.
 */
export const channels = pgTable(
  "channels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: varchar("name", { length: 120 }).notNull().default(""),
    kind: varchar("kind", { length: 8 }).notNull().default("channel"), // channel | dm
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("channels_kind_idx").on(t.kind)],
);

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    // Hot path: "which channels is this user in" (list view) and membership checks.
    index("channel_members_user_idx").on(t.userId),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    authorUserId: integer("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorEmail: varchar("author_email", { length: 255 }).notNull().default(""), // denormalized, matches auditLogs.actorEmail
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_channel_idx").on(t.channelId, t.createdAt)],
);

// ── automation (workspace) ──────────────────────────────────────────────────
/**
 * Trigger -> action rules, evaluated in-process at the same points
 * services/pm.ts already writes activity/notification rows — no queue
 * (BullMQ/Redis), per the "hold off on new infra" decision. Fine at this
 * event volume; a queue only earns its keep once actions need retries or
 * cross-process fan-out.
 */
export const automationRules = pgTable(
  "automation_rules",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: varchar("name", { length: 200 }).notNull(),
    // task_created | task_status_changed | task_assigned | task_commented
    triggerType: varchar("trigger_type", { length: 32 }).notNull(),
    triggerFilter: text("trigger_filter").notNull().default("{}"), // JSON, shape depends on trigger
    // notify_user | notify_assignee | post_to_channel | change_task_status
    actionType: varchar("action_type", { length: 32 }).notNull(),
    actionConfig: text("action_config").notNull().default("{}"), // JSON, shape depends on action
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: integer("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("automation_rules_trigger_idx").on(t.triggerType, t.enabled)],
);

/** Execution log — lets an operator see whether a rule actually fired and
 * what it did, instead of trusting it silently. */
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    ruleId: integer("rule_id").references(() => automationRules.id, { onDelete: "set null" }),
    ruleName: varchar("rule_name", { length: 200 }).notNull().default(""), // denormalized: survives rule deletion
    entityType: varchar("entity_type", { length: 16 }).notNull().default(""),
    entityId: integer("entity_id"),
    status: varchar("status", { length: 16 }).notNull().default("ok"), // ok | error
    detail: text("detail").notNull().default(""),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("automation_runs_at_idx").on(t.at)],
);

// ── whiteboard ───────────────────────────────────────────────────────────────
/**
 * Infinite-canvas boards: sticky notes + freehand strokes. Workspace-wide
 * (a list of named boards, not tied to an initiative), same scope as Chat/
 * Wiki. Real-time sync goes entirely over the dashboard WebSocket (see
 * ws/server.ts `board_op`) rather than REST + a separate broadcast step —
 * unlike chat (which has a REST fallback), a board has no meaningful
 * "offline send," so there's no reason to duplicate the write path.
 *
 * Explicit v1 cuts: no live cursors/presence, no resize handles, no
 * undo/redo, no per-board access control (same open-to-everyone posture as
 * the rest of the PM module).
 */
export const whiteboards = pgTable("whiteboards", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 200 }).notNull(),
  createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const whiteboardElements = pgTable(
  "whiteboard_elements",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    boardId: integer("board_id")
      .notNull()
      .references(() => whiteboards.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 8 }).notNull(), // note | stroke
    data: text("data").notNull(), // JSON, shape depends on kind (see ws/server.ts)
    createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("whiteboard_elements_board_idx").on(t.boardId)],
);

// ── client portal (initiative sharing) ────────────────────────────────────────
/**
 * Which initiatives a `client`-role user may see — mirrors `userSystems`'
 * shape and role exactly (composite PK join table, additive grant), applied
 * to the PM domain instead of the fleet. See core/rbac.ts CLIENT and
 * services/pm.ts's role branch for how this is enforced.
 */
export const initiativeClients = pgTable(
  "initiative_clients",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    initiativeId: integer("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.initiativeId] }),
    index("initiative_clients_initiative_idx").on(t.initiativeId),
  ],
);

// ── sync logs ─────────────────────────────────────────────────────────────────
export const syncLogs = pgTable(
  "sync_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    systemId: varchar("system_id", { length: 64 }).notNull(),
    received: integer("received").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    duplicates: integer("duplicates").notNull().default(0),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sync_logs_system_at_idx").on(t.systemId, t.at)],
);

// ── audit log ─────────────────────────────────────────────────────────────────
/** Never records secrets, prompts, responses, or source code. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    actorUserId: integer("actor_user_id"),
    actorEmail: varchar("actor_email", { length: 255 }).notNull().default(""),
    action: varchar("action", { length: 64 }).notNull(),
    target: varchar("target", { length: 255 }).notNull().default(""),
    detail: text("detail").notNull().default(""),
    // NEW: request context, for forensic value the Python model lacked.
    ip: varchar("ip", { length: 64 }).notNull().default(""),
    userAgent: varchar("user_agent", { length: 255 }).notNull().default(""),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_at_idx").on(t.at), index("audit_logs_action_idx").on(t.action)],
);

// ── Claude subscription accounts ──────────────────────────────────────────────
/**
 * One row per Claude subscription (Pro, Max 5x, …), reported by agents that
 * have account reporting switched on. Identity only — no credentials ever
 * reach this table; see `agent/meterhouse/account.py` for the allowlist.
 */
export const claudeAccounts = pgTable(
  "claude_accounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    // The natural key the agent reports. An integer surrogate is used for
    // joins because this column will land on usage_events in Phase 2.
    accountUuid: varchar("account_uuid", { length: 64 }).notNull().unique(),
    emailAddress: varchar("email_address", { length: 255 }).notNull().default(""),
    displayName: varchar("display_name", { length: 120 }).notNull().default(""),
    organizationName: varchar("organization_name", { length: 200 }).notNull().default(""),
    organizationUuid: varchar("organization_uuid", { length: 64 }).notNull().default(""),
    // Raw values from Anthropic, e.g. "claude_max" / "default_claude_max_5x".
    // Stored verbatim; the human label is derived in core/plans.ts so an
    // unrecognised tier degrades gracefully instead of needing a migration.
    organizationType: varchar("organization_type", { length: 64 }).notNull().default(""),
    rateLimitTier: varchar("rate_limit_tier", { length: 64 }).notNull().default(""),
    organizationRole: varchar("organization_role", { length: 40 }).notNull().default(""),
    billingType: varchar("billing_type", { length: 40 }).notNull().default(""),
    hasExtraUsageEnabled: boolean("has_extra_usage_enabled").notNull().default(false),
    /**
     * Billing timeline, as reported by Claude Code.
     *
     * Anthropic does not publish a next-invoice date anywhere the agent can
     * read, so `subscriptionCreatedAt` is the only anchor for a renewal
     * estimate (billing recurs on its anniversary) and `trialEndsAt` is the
     * one genuine pay-by date available. Stored as text exactly as reported —
     * these are display values, and an unparseable string should degrade to
     * "unknown" rather than fail an ingest.
     */
    accountCreatedAt: varchar("account_created_at", { length: 40 }).notNull().default(""),
    subscriptionCreatedAt: varchar("subscription_created_at", { length: 40 })
      .notNull()
      .default(""),
    trialEndsAt: varchar("trial_ends_at", { length: 40 }).notNull().default(""),
    seatTier: varchar("seat_tier", { length: 64 }).notNull().default(""),
    userRateLimitTier: varchar("user_rate_limit_tier", { length: 64 }).notNull().default(""),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("claude_accounts_org_idx").on(t.organizationUuid)],
);

/**
 * Which account a machine was signed into, over time.
 *
 * Half-open intervals `[validFrom, validTo)`; `validTo IS NULL` means "still
 * current". Storing this as history rather than a column on `systems` is what
 * stops a account switch from silently rewriting who used what last month.
 * This one table answers both "account switching history" and "user ↔ account
 * assignment history" (the latter by joining `user_systems`).
 */
export const systemAccountBindings = pgTable(
  "system_account_bindings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => claudeAccounts.id, { onDelete: "cascade" }),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    source: varchar("source", { length: 16 }).notNull().default("agent"), // agent | manual
  },
  (t) => [
    // At most one open binding per machine. Enforced by the database rather
    // than by application care, because a double-open row would corrupt every
    // account attribution downstream.
    uniqueIndex("system_account_bindings_open_idx")
      .on(t.systemId)
      .where(sql`valid_to IS NULL`),
    index("system_account_bindings_system_idx").on(t.systemId, t.validFrom),
    index("system_account_bindings_account_idx").on(t.accountId, t.validFrom),
  ],
);

/**
 * Rate-limit readings, as Claude Code itself cached them.
 *
 * This is the real quota position — unlike the token-cost figures elsewhere in
 * this schema, which are an observability estimate. `percent` is 0-100 (not a
 * fraction) and `severity` is Anthropic's own verdict, so the health indicator
 * is reported rather than invented.
 *
 * Dollar columns are nullable on purpose: subscription plans report them as
 * null, and a 0 would read as "nothing used" rather than "not applicable".
 */
export const accountUsageSnapshots = pgTable(
  "account_usage_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id")
      .notNull()
      .references(() => claudeAccounts.id, { onDelete: "cascade" }),
    // Which machine observed this. Two PCs on one account both report, which
    // gives freshness and a cross-check.
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(), // session | weekly_all | weekly_scoped
    grp: varchar("grp", { length: 32 }).notNull().default(""), // session | weekly
    scopeLabel: varchar("scope_label", { length: 80 }).notNull().default(""), // model name
    percent: numeric("percent", { precision: 6, scale: 2 }).notNull().default("0"),
    severity: varchar("severity", { length: 24 }).notNull().default(""),
    isActive: boolean("is_active").notNull().default(false),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    limitDollars: numeric("limit_dollars", { precision: 12, scale: 4 }),
    usedDollars: numeric("used_dollars", { precision: 12, scale: 4 }),
    remainingDollars: numeric("remaining_dollars", { precision: 12, scale: 4 }),
    // Claude Code's own cache timestamp — the reading can be stale, so this is
    // surfaced in the UI rather than implying the number is live.
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Re-reporting an unchanged cached value must not inflate the series.
    uniqueIndex("account_usage_snapshots_dedup_idx").on(t.accountId, t.kind, t.fetchedAt),
    index("account_usage_snapshots_recent_idx").on(t.accountId, t.kind, t.fetchedAt),
  ],
);

// ── human prompts ─────────────────────────────────────────────────────────────
/**
 * Prompts a person actually typed, per session per day.
 *
 * Kept out of `usage_events` deliberately: a prompt carries no tokens, so
 * folding it in would inflate `event_count`, session counts, and every token
 * average in the app. Counts arrive cumulative and are merged with GREATEST,
 * which makes retries and out-of-order batches harmless.
 *
 * Only counted from the day the agent gained the ability — earlier history has
 * no rows, and the UI shows that as "—" rather than a misleading zero.
 */
export const promptDaily = pgTable(
  "prompt_daily",
  {
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    day: varchar("day", { length: 10 }).notNull(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    promptCount: integer("prompt_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.systemId, t.day, t.sessionId] }),
    index("prompt_daily_day_idx").on(t.day),
    index("prompt_daily_session_idx").on(t.systemId, t.sessionId),
  ],
);

/**
 * Session titles, when the machine opts into sending them.
 *
 * A title describes what somebody was working on, so this is gated behind its
 * own agent flag (`session_titles_enabled`, default off) rather than riding
 * along with token counts.
 */
export const sessionMeta = pgTable(
  "session_meta",
  {
    systemId: varchar("system_id", { length: 64 })
      .notNull()
      .references(() => systems.systemId, { onDelete: "cascade" }),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    title: varchar("title", { length: 300 }).notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.systemId, t.sessionId] })],
);

// ── settings ──────────────────────────────────────────────────────────────────
/**
 * Fleet-wide settings, as a key/value table rather than a one-row table with a
 * column per setting. Settings get added often and a KV row needs no migration;
 * the typed contract lives in `core/settings.ts`, which is also where defaults
 * are defined so a missing row is never a broken page.
 */
export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByUserId: integer("updated_by_user_id"),
});

/**
 * Per-user preferences. Theme deliberately stays in localStorage — it must
 * apply before the first paint, which a server round-trip cannot do.
 */
export const userPreferences = pgTable("user_preferences", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // JSON blob: preference keys change shape more often than they deserve a
  // migration, and nothing queries inside it.
  notifications: text("notifications").notNull().default("{}"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── inferred types ────────────────────────────────────────────────────────────
export type RoleRow = typeof roles.$inferSelect;
export type AppSettingRow = typeof appSettings.$inferSelect;
export type UserPreferenceRow = typeof userPreferences.$inferSelect;
export type ClaudeAccountRow = typeof claudeAccounts.$inferSelect;
export type SystemAccountBindingRow = typeof systemAccountBindings.$inferSelect;
export type AccountUsageSnapshotRow = typeof accountUsageSnapshots.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SystemRow = typeof systems.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;
export type EnrollTokenRow = typeof enrollTokens.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AgentCommandRow = typeof agentCommands.$inferSelect;
export type InitiativeRow = typeof initiatives.$inferSelect;
export type MilestoneRow = typeof milestones.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskCommentRow = typeof taskComments.$inferSelect;
export type DocRow = typeof docs.$inferSelect;
export type PmActivityRow = typeof pmActivity.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type ChannelRow = typeof channels.$inferSelect;
export type ChannelMemberRow = typeof channelMembers.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type AutomationRuleRow = typeof automationRules.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type WhiteboardRow = typeof whiteboards.$inferSelect;
export type WhiteboardElementRow = typeof whiteboardElements.$inferSelect;
export type InitiativeClientRow = typeof initiativeClients.$inferSelect;
export type EpicRow = typeof epics.$inferSelect;
export type SprintRow = typeof sprints.$inferSelect;
export type BoardColumnRow = typeof boardColumns.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;
export type TaskLabelRow = typeof taskLabels.$inferSelect;
