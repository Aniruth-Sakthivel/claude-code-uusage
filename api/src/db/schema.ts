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
