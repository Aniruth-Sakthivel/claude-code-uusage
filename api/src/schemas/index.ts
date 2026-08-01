/**
 * API contract (Zod).
 *
 * Single source of truth for request validation and response shape. The
 * frontend's TypeScript types are derived from these, so a contract change
 * cannot silently drift from the client.
 */

import { z } from "zod";

import { ROLES } from "../core/rbac.js";

// ── shared ────────────────────────────────────────────────────────────────────
export const roleEnum = z.enum(ROLES);

export const userOut = z.object({
  id: z.number().int(),
  email: z.string(),
  full_name: z.string(),
  role: roleEnum,
  is_active: z.boolean(),
  system_ids: z.array(z.string()),
  capabilities: z.array(z.string()),
});
export type UserOut = z.infer<typeof userOut>;

export const registrationStatus = z.object({ open: z.boolean() });

// ── systems ───────────────────────────────────────────────────────────────────
export const systemOut = z.object({
  system_id: z.string(),
  display_name: z.string(),
  hostname: z.string(),
  agent_version: z.string(),
  owner: z.string(),
  location: z.string(),
  environment: z.string(),
  notes: z.string(),
  last_seen_at: z.string().nullable(),
  last_sync_at: z.string().nullable(),
  created_at: z.string(),
  status: z.enum(["online", "offline"]),
  total_tokens: z.number(),
  sessions: z.number(),
  projects: z.number(),
  /** True when the agent has never successfully synced — drives the UI hint. */
  never_synced: z.boolean(),
});

export const systemCreate = z.object({
  display_name: z.string().min(1).max(120),
  owner: z.string().max(120).default(""),
  location: z.string().max(120).default(""),
  environment: z.string().max(40).default(""),
  notes: z.string().default(""),
});

export const systemCreated = z.object({
  system: systemOut,
  api_key: z.string(),
});

// ── agent endpoints ───────────────────────────────────────────────────────────
export const registerRequest = z.object({
  display_name: z.string().max(120).nullish(),
  hostname: z.string().max(255).nullish(),
  agent_version: z.string().max(32).nullish(),
});

export const registerResponse = z.object({
  system_id: z.string(),
  display_name: z.string(),
});

// ── Claude account reporting ──────────────────────────────────────────────────
/**
 * Mirrors the agent's allowlist in `agent/meterhouse/account.py`. Kept strict
 * on purpose: the server should reject anything the agent was not supposed to
 * send, rather than quietly storing it.
 */
export const accountIdentityIn = z
  .object({
    account_uuid: z.string().min(1).max(64),
    email_address: z.string().max(255).default(""),
    display_name: z.string().max(120).default(""),
    organization_name: z.string().max(200).default(""),
    organization_uuid: z.string().max(64).default(""),
    organization_type: z.string().max(64).default(""),
    rate_limit_tier: z.string().max(64).default(""),
    organization_role: z.string().max(40).default(""),
    billing_type: z.string().max(40).default(""),
    has_extra_usage_enabled: z.boolean().default(false),
  })
  .strict();

const accountLimitIn = z.object({
  kind: z.string().min(1).max(32),
  group: z.string().max(32).default(""),
  scope_label: z.string().max(80).default(""),
  // A percentage 0-100, not a fraction. Verified against real Claude Code data.
  percent: z.number().min(0).max(1000).default(0),
  severity: z.string().max(24).default(""),
  is_active: z.boolean().default(false),
  resets_at: z.string().max(64).default(""),
});

const accountDollarsIn = z.object({
  limit_dollars: z.number().optional(),
  used_dollars: z.number().optional(),
  remaining_dollars: z.number().optional(),
});

export const accountReportIn = z.object({
  account: accountIdentityIn,
  utilization: z
    .object({
      fetched_at_ms: z.number().int().nonnegative().default(0),
      limits: z.array(accountLimitIn).max(32).default([]),
      dollars: z.record(z.string(), accountDollarsIn).default({}),
    })
    .nullish(),
});

export const usageEventIn = z.object({
  suffix: z.string().min(1).max(96),
  session_id: z.string().max(64),
  project_name: z.string().max(255).default("unknown"),
  ts_utc: z.string().max(40),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD"),
  model: z.string().max(80).default(""),
  model_family: z.string().max(24).default("unknown"),
  input_tokens: z.number().int().min(0).default(0),
  output_tokens: z.number().int().min(0).default(0),
  cache_read_tokens: z.number().int().min(0).default(0),
  cache_creation_tokens: z.number().int().min(0).default(0),
  total_tokens: z.number().int().min(0).default(0),
  tool_name: z.string().max(80).nullish(),
  is_subagent: z.number().int().min(0).max(1).default(0),
  agent_id: z.string().max(64).nullish(),
});

/** Batch cap: the previous API accepted unbounded arrays. */
export const MAX_SYNC_BATCH = 1000;

/** Cumulative human-prompt count for one session on one day. */
export const promptDailyIn = z.object({
  session_id: z.string().min(1).max(64),
  day: z.string().length(10),
  prompt_count: z.number().int().min(0).max(100_000),
});

/** Only sent by machines that opted into session-title sync. */
export const sessionTitleIn = z.object({
  session_id: z.string().min(1).max(64),
  title: z.string().max(300),
});

export const syncRequest = z.object({
  events: z.array(usageEventIn).max(MAX_SYNC_BATCH, {
    message: `Batch too large — send at most ${MAX_SYNC_BATCH} events per request`,
  }),
  // Both default to empty so an older agent's payload still validates.
  prompts: z.array(promptDailyIn).max(MAX_SYNC_BATCH).default([]),
  session_titles: z.array(sessionTitleIn).max(MAX_SYNC_BATCH).default([]),
});

export const syncResponse = z.object({
  received: z.number(),
  inserted: z.number(),
  duplicates: z.number(),
  failed: z.number(),
});

// ── dashboard ─────────────────────────────────────────────────────────────────
export const rankingItem = z.object({
  system_id: z.string(),
  display_name: z.string(),
  total_tokens: z.number(),
  pct: z.number(),
});

export const summaryOut = z.object({
  today_tokens: z.number(),
  week_tokens: z.number(),
  month_tokens: z.number(),
  total_tokens: z.number(),
  active_systems: z.number(),
  total_systems: z.number(),
  highest: rankingItem.nullable(),
  /** True when the caller's view is limited, so the UI can label percentages. */
  scoped: z.boolean(),
});

export const timeseriesOut = z.object({
  days: z.array(z.string()),
  systems: z.array(rankingItem),
  points: z.array(z.object({ day: z.string(), values: z.record(z.number()) })),
});

export const projectOut = z.object({
  project_name: z.string(),
  system_id: z.string(),
  total_tokens: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_creation_tokens: z.number(),
  sessions: z.number(),
});

export const sessionOut = z.object({
  session_id: z.string(),
  system_id: z.string(),
  project_name: z.string(),
  model: z.string(),
  first_ts: z.string(),
  last_ts: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_tokens: z.number(),
  total_tokens: z.number(),
});

export const rangeQuery = z.object({
  range: z.enum(["today", "7d", "30d", "90d"]).default("7d"),
});

// ── admin: users ──────────────────────────────────────────────────────────────
const emailField = z.string().min(3).max(255).includes("@", { message: "Invalid email" });

export const userCreate = z.object({
  email: emailField,
  full_name: z.string().max(120).default(""),
  role: roleEnum,
  system_ids: z.array(z.string()).default([]),
  /**
   * Optional. When omitted the user is *invited* by email and chooses their own
   * password, which avoids sharing credentials out of band.
   */
  password: z.string().min(8).optional(),
});

export const userUpdate = z.object({
  full_name: z.string().max(120).nullish(),
  password: z.string().min(8).nullish(),
  role: roleEnum.nullish(),
  is_active: z.boolean().nullish(),
  system_ids: z.array(z.string()).nullish(),
});

export const roleOut = z.object({ name: roleEnum, description: z.string() });

// ── admin: api keys ───────────────────────────────────────────────────────────
export const apiKeyOut = z.object({
  id: z.number().int(),
  system_id: z.string(),
  name: z.string(),
  prefix: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  active: z.boolean(),
});

export const apiKeyCreate = z.object({ name: z.string().max(120).default("") });

export const apiKeyCreated = z.object({ key: apiKeyOut, api_key: z.string() });

export const auditOut = z.object({
  id: z.number().int(),
  actor_email: z.string(),
  action: z.string(),
  target: z.string(),
  detail: z.string(),
  at: z.string(),
});

// ── onboarding (one-click connect) ────────────────────────────────────────────
export const connectRequest = z.object({
  display_name: z.string().min(1).max(120),
  /** Reuse an existing system instead of creating one (re-issues a key). */
  system_id: z.string().nullish(),
  owner: z.string().max(120).default(""),
  location: z.string().max(120).default(""),
  environment: z.string().max(40).default(""),
});

export const connectResponse = z.object({
  system_id: z.string(),
  display_name: z.string(),
  /** The one-liner the user pastes into PowerShell. */
  install_command: z.string(),
  /** Expiry of the enrollment token embedded in the command. */
  expires_at: z.string(),
  /** Full key, shown once, for users who prefer manual setup. */
  api_key: z.string(),
  manual_commands: z.string(),
  /** Direct download for the standalone exe, for people who'd rather not paste a command. */
  exe_url: z.string(),
});

export const systemStatusOut = z.object({
  system_id: z.string(),
  display_name: z.string(),
  status: z.enum(["online", "offline"]),
  last_seen_at: z.string().nullable(),
  last_sync_at: z.string().nullable(),
  total_events: z.number(),
  never_synced: z.boolean(),
});

export const errorOut = z.object({ detail: z.string() });
