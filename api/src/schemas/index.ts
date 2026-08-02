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

// ── agent commands (fleet management) ─────────────────────────────────────────
export const commandAction = z.enum(["scan_now", "pause", "resume", "set_config"]);

/** Only the tunables it's safe for an operator to push remotely. */
export const commandSetConfigPayload = z
  .object({
    scan_interval_seconds: z.number().int().min(5).max(86_400).optional(),
    ws_enabled: z.boolean().optional(),
    session_titles_enabled: z.boolean().optional(),
    account_reporting_enabled: z.boolean().optional(),
  })
  .strict();

export const commandCreate = z.object({
  action: commandAction,
  payload: commandSetConfigPayload.default({}),
});

export const commandOut = z.object({
  id: z.number().int(),
  system_id: z.string(),
  action: commandAction,
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "acked", "failed"]),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
  acked_at: z.string().nullable(),
  ack_detail: z.string(),
});

/** What an agent receives when it checks in — deliberately minimal, no status. */
export const pendingCommandOut = z.object({
  id: z.number().int(),
  action: commandAction,
  payload: z.record(z.string(), z.unknown()),
});

/** Pending fleet-management commands are attached to every check-in response
 * (register/heartbeat/sync) so a REST-only agent picks them up on its next
 * scan cycle without needing the optional WebSocket channel. */
export const commandsField = z.array(pendingCommandOut).default([]);

export const commandAckRequest = z.object({
  status: z.enum(["acked", "failed"]),
  detail: z.string().max(2000).default(""),
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
  commands: commandsField,
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
  commands: commandsField,
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

// ── project management (initiatives) ───────────────────────────────────────────
export const initiativeStatus = z.enum(["active", "on_hold", "completed", "archived"]);
export const taskStatus = z.enum(["todo", "in_progress", "done"]);
export const milestoneStatus = z.enum(["open", "done"]);

export const initiativeCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
});
export const initiativeUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  status: initiativeStatus.optional(),
});
export const initiativeOut = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  status: initiativeStatus,
  created_by_user_id: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  task_count: z.number().int(),
  open_task_count: z.number().int(),
});

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .nullable();

export const milestoneCreate = z.object({
  name: z.string().min(1).max(200),
  due_date: dateField.default(null),
});
export const milestoneUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  due_date: dateField.optional(),
  status: milestoneStatus.optional(),
});
export const milestoneOut = z.object({
  id: z.number().int(),
  initiative_id: z.number().int(),
  name: z.string(),
  due_date: z.string().nullable(),
  status: milestoneStatus,
  created_at: z.string(),
});

export const taskPriority = z.enum(["low", "medium", "high", "urgent"]);

export const taskCreate = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).default(""),
  milestone_id: z.number().int().nullable().default(null),
  assignee_user_id: z.number().int().nullable().default(null),
  due_date: dateField.default(null),
  epic_id: z.number().int().nullable().default(null),
  sprint_id: z.number().int().nullable().default(null),
  parent_task_id: z.number().int().nullable().default(null),
  priority: taskPriority.default("medium"),
  story_points: z.number().int().min(0).max(999).nullable().default(null),
  // Free-form now (validated against the initiative's actual board_columns
  // server-side, not this fixed enum) — omit to default to the first column.
  status: z.string().max(32).optional(),
});
export const taskUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  status: z.string().max(32).optional(),
  milestone_id: z.number().int().nullable().optional(),
  assignee_user_id: z.number().int().nullable().optional(),
  due_date: dateField.optional(),
  epic_id: z.number().int().nullable().optional(),
  sprint_id: z.number().int().nullable().optional(),
  parent_task_id: z.number().int().nullable().optional(),
  priority: taskPriority.optional(),
  story_points: z.number().int().min(0).max(999).nullable().optional(),
});

export const labelOut = z.object({ id: z.number().int(), name: z.string(), color: z.string() });

export const taskOut = z.object({
  id: z.number().int(),
  initiative_id: z.number().int(),
  milestone_id: z.number().int().nullable(),
  epic_id: z.number().int().nullable(),
  sprint_id: z.number().int().nullable(),
  parent_task_id: z.number().int().nullable(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  priority: taskPriority,
  story_points: z.number().int().nullable(),
  assignee_user_id: z.number().int().nullable(),
  created_by_user_id: z.number().int().nullable(),
  due_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  comment_count: z.number().int(),
  labels: z.array(labelOut).default([]),
});

export const epicCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
  color: z.string().max(16).default("#6366f1"),
});
export const epicUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  color: z.string().max(16).optional(),
  status: z.enum(["open", "done"]).optional(),
});
export const epicOut = z.object({
  id: z.number().int(),
  initiative_id: z.number().int(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  status: z.enum(["open", "done"]),
  created_at: z.string(),
});

export const sprintCreate = z.object({
  name: z.string().min(1).max(200),
  start_date: dateField.default(null),
  end_date: dateField.default(null),
});
export const sprintUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  start_date: dateField.optional(),
  end_date: dateField.optional(),
  status: z.enum(["planned", "active", "completed"]).optional(),
});
export const sprintOut = z.object({
  id: z.number().int(),
  initiative_id: z.number().int(),
  name: z.string(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  status: z.enum(["planned", "active", "completed"]),
  created_at: z.string(),
  task_count: z.number().int(),
});

export const columnCreate = z.object({
  key: z.string().min(1).max(32).regex(/^[a-z0-9_]+$/, "lowercase letters, numbers, underscore only"),
  label: z.string().min(1).max(60),
});
export const columnUpdate = z.object({
  label: z.string().min(1).max(60).optional(),
  position: z.number().int().min(0).optional(),
  is_done_column: z.boolean().optional(),
});
export const columnOut = z.object({
  id: z.number().int(),
  initiative_id: z.number().int(),
  key: z.string(),
  label: z.string(),
  position: z.number().int(),
  is_done_column: z.boolean(),
});

export const labelCreate = z.object({
  name: z.string().min(1).max(60),
  color: z.string().max(16).default("#64748b"),
});

export const taskLabelAttach = z.object({ label_id: z.number().int() });
export const taskSprintAssign = z.object({ sprint_id: z.number().int().nullable() });

export const commentCreate = z.object({ body: z.string().min(1).max(10_000) });
export const commentOut = z.object({
  id: z.number().int(),
  task_id: z.number().int(),
  author_user_id: z.number().int().nullable(),
  author_email: z.string(),
  body: z.string(),
  created_at: z.string(),
});

export const docCreate = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(200_000).default(""),
});
export const docUpdate = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
});
export const docOut = z.object({
  id: z.number().int(),
  initiative_id: z.number().int().nullable(),
  title: z.string(),
  body: z.string(),
  created_by_user_id: z.number().int().nullable(),
  updated_by_user_id: z.number().int().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ── team chat ──────────────────────────────────────────────────────────────────
export const channelCreate = z.object({
  name: z.string().min(1).max(120),
  member_ids: z.array(z.number().int()).max(200).default([]),
});

export const dmCreate = z.object({ user_id: z.number().int() });

export const messageCreate = z.object({ body: z.string().min(1).max(10_000) });

export const channelOut = z.object({
  id: z.number().int(),
  name: z.string(),
  kind: z.enum(["channel", "dm"]),
  member_ids: z.array(z.number().int()),
  last_message_at: z.string().nullable(),
});

export const chatMessageOut = z.object({
  id: z.number().int(),
  channel_id: z.number().int(),
  author_user_id: z.number().int().nullable(),
  author_email: z.string(),
  body: z.string(),
  created_at: z.string(),
});

// ── whiteboard ───────────────────────────────────────────────────────────────
export const boardCreate = z.object({ name: z.string().min(1).max(200) });
export const boardOut = z.object({
  id: z.number().int(),
  name: z.string(),
  created_at: z.string(),
});

export const elementOut = z.object({
  id: z.number().int(),
  board_id: z.number().int(),
  kind: z.enum(["note", "stroke"]),
  data: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

// ── automation ───────────────────────────────────────────────────────────────
export const automationTrigger = z.enum([
  "task_created",
  "task_status_changed",
  "task_assigned",
  "task_commented",
]);
export const automationAction = z.enum([
  "notify_user",
  "notify_assignee",
  "post_to_channel",
  "change_task_status",
]);

export const automationRuleCreate = z.object({
  name: z.string().min(1).max(200),
  trigger_type: automationTrigger,
  trigger_filter: z.record(z.string(), z.unknown()).default({}),
  action_type: automationAction,
  action_config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export const automationRuleUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  trigger_filter: z.record(z.string(), z.unknown()).optional(),
  action_config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export const automationRuleOut = z.object({
  id: z.number().int(),
  name: z.string(),
  trigger_type: z.string(),
  trigger_filter: z.record(z.string(), z.unknown()),
  action_type: z.string(),
  action_config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  created_at: z.string(),
});

export const automationRunOut = z.object({
  id: z.number().int(),
  rule_id: z.number().int().nullable(),
  rule_name: z.string(),
  entity_type: z.string(),
  entity_id: z.number().int().nullable(),
  status: z.enum(["ok", "error"]),
  detail: z.string(),
  at: z.string(),
});

export const reportsOut = z.object({
  initiatives_by_status: z.array(z.object({ status: z.string(), n: z.number().int() })),
  tasks_by_status: z.array(z.object({ status: z.string(), n: z.number().int() })),
  workload: z.array(
    z.object({ user_id: z.number().int(), email: z.string(), full_name: z.string(), n: z.number().int() }),
  ),
  completed_by_day: z.array(z.object({ day: z.string(), n: z.number().int() })),
});

export const searchResultOut = z.object({
  kind: z.enum(["initiative", "task", "doc", "channel"]),
  id: z.number().int(),
  title: z.string(),
  subtitle: z.string(),
  link: z.string(),
});

export const calendarItemOut = z.object({
  kind: z.enum(["task", "milestone"]),
  id: z.number().int(),
  initiative_id: z.number().int(),
  initiative_name: z.string(),
  title: z.string(),
  due_date: z.string(),
  status: z.string(),
});

export const activityOut = z.object({
  id: z.number().int(),
  actor_email: z.string(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.number().int(),
  detail: z.string(),
  at: z.string(),
});
