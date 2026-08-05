/**
 * API contract types — mirror the Zod schemas in api/src/schemas/index.ts.
 * Keep them in sync when the backend contract changes.
 */

export type Role = "admin" | "manager" | "developer" | "viewer" | "client";

export type Capability =
  | "view_all"
  | "manage_users"
  | "manage_keys"
  | "manage_systems"
  | "view_audit"
  | "export"
  | "connect_own_pc";

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  system_ids: string[];
  /** Server-computed. The UI gates on these instead of hardcoding a matrix. */
  capabilities: Capability[];
}

/** A machine, including its live agent state (spread in by the API). */
export interface SystemRow extends ScanActivity {
  system_id: string;
  display_name: string;
  hostname: string;
  agent_version: string;
  owner: string;
  location: string;
  environment: string;
  notes: string;
  last_seen_at: string | null;
  last_sync_at: string | null;
  created_at: string;
  status: "online" | "offline";
  /**
   * Graded liveness. `status` alone cannot separate a sleeping laptop from an
   * agent that died when its terminal closed — this can.
   */
  health: AgentHealth;
  /** Milliseconds of silence; null when the agent has never checked in. */
  silent_for_ms: number | null;
  /** Plain-language explanation, safe to render as-is. */
  reason: string;
  total_tokens: number;
  sessions: number;
  projects: number;
  /** True until the agent's first successful sync — drives the setup hint. */
  never_synced: boolean;
}

export type AgentHealth = "never" | "healthy" | "late" | "stalled" | "dead";

export type AgentState =
  | "unknown"
  | "idle"
  | "scanning"
  | "scanned"
  | "syncing"
  | "paused"
  | "error";

export interface SystemCreated {
  system: SystemRow;
  api_key: string;
}

// ── project management (initiatives) ────────────────────────────────────────────
export type InitiativeStatus = "active" | "on_hold" | "completed" | "archived";
export type TaskStatus = "todo" | "in_progress" | "done";
export type MilestoneStatus = "open" | "done";

export interface Initiative {
  id: number;
  name: string;
  description: string;
  status: InitiativeStatus;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
  task_count: number;
  open_task_count: number;
}

export interface Milestone {
  id: number;
  initiative_id: number;
  name: string;
  due_date: string | null;
  status: MilestoneStatus;
  created_at: string;
}

export interface Task {
  id: number;
  initiative_id: number;
  milestone_id: number | null;
  title: string;
  description: string;
  status: TaskStatus;
  assignee_user_id: number | null;
  created_by_user_id: number | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  comment_count: number;
}

export interface TaskComment {
  id: number;
  task_id: number;
  author_user_id: number | null;
  author_email: string;
  body: string;
  created_at: string;
}

export interface Doc {
  id: number;
  initiative_id: number | null;
  title: string;
  body: string;
  created_by_user_id: number | null;
  updated_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

/** Minimal, unprivileged user listing for the assignee picker — see
 * `GET /api/v1/pm/assignees` (deliberately not the capability-gated
 * `/admin/users`, since PM is open to every signed-in user). */
export interface Assignee {
  id: number;
  email: string;
  full_name: string;
}

// ── team chat ────────────────────────────────────────────────────────────────
export type ChannelKind = "channel" | "dm";

export interface Channel {
  id: number;
  name: string;
  kind: ChannelKind;
  member_ids: number[];
  last_message_at: string | null;
}

export interface ChatMessage {
  id: number;
  channel_id: number;
  author_user_id: number | null;
  author_email: string;
  body: string;
  created_at: string;
}

export interface WhiteboardSummary {
  id: number;
  name: string;
  created_at: string;
}

export type AutomationTrigger =
  | "task_created"
  | "task_status_changed"
  | "task_assigned"
  | "task_commented";
export type AutomationAction = "notify_user" | "notify_assignee" | "post_to_channel" | "change_task_status";

export interface AutomationRule {
  id: number;
  name: string;
  trigger_type: AutomationTrigger;
  trigger_filter: Record<string, unknown>;
  action_type: AutomationAction;
  action_config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

export interface AutomationRun {
  id: number;
  rule_id: number | null;
  rule_name: string;
  entity_type: string;
  entity_id: number | null;
  status: "ok" | "error";
  detail: string;
  at: string;
}

export interface ReportsSummary {
  initiatives_by_status: { status: string; n: number }[];
  tasks_by_status: { status: string; n: number }[];
  workload: { user_id: number; email: string; full_name: string; n: number }[];
  completed_by_day: { day: string; n: number }[];
}

export interface SearchResult {
  kind: "initiative" | "task" | "doc" | "channel";
  id: number;
  title: string;
  subtitle: string;
  link: string;
}

export interface CalendarItem {
  kind: "task" | "milestone";
  id: number;
  initiative_id: number;
  initiative_name: string;
  title: string;
  due_date: string;
  status: string;
}

export interface Notification {
  id: number;
  type: string;
  title: string;
  body: string;
  entity_type: string;
  entity_id: number | null;
  link: string;
  read_at: string | null;
  created_at: string;
}

export interface PmActivityEntry {
  id: number;
  actor_email: string;
  action: string;
  entity_type: string;
  entity_id: number;
  detail: string;
  at: string;
}

// ── fleet management (agent commands) ──────────────────────────────────────────
export type CommandAction = "scan_now" | "pause" | "resume" | "set_config";

/** Only the tunables it's safe to push remotely — mirrors the server allowlist. */
export interface SetConfigPayload {
  scan_interval_seconds?: number;
  ws_enabled?: boolean;
  session_titles_enabled?: boolean;
  account_reporting_enabled?: boolean;
}

export interface AgentCommand {
  id: number;
  system_id: string;
  action: CommandAction;
  payload: SetConfigPayload;
  status: "pending" | "acked" | "failed";
  created_at: string;
  delivered_at: string | null;
  acked_at: string | null;
  ack_detail: string;
}

export interface RankingItem {
  system_id: string;
  display_name: string;
  total_tokens: number;
  pct: number;
}

export interface Summary {
  today_tokens: number;
  week_tokens: number;
  month_tokens: number;
  total_tokens: number;
  active_systems: number;
  total_systems: number;
  highest: RankingItem | null;
  /** True when this user sees only a subset, so percentages are relative. */
  scoped: boolean;
}

export interface TimeseriesPoint {
  day: string;
  values: Record<string, number>;
}

export interface Timeseries {
  days: string[];
  systems: RankingItem[];
  points: TimeseriesPoint[];
}

export interface Project {
  project_name: string;
  system_id: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  sessions: number;
}

export interface SessionRow {
  session_id: string;
  system_id: string;
  project_name: string;
  model: string;
  first_ts: string;
  last_ts: string;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  total_tokens: number;
}

export interface ApiKeyRow {
  id: number;
  system_id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  active: boolean;
}

export interface ApiKeyCreated {
  key: ApiKeyRow;
  api_key: string;
}

export interface AuditRow {
  id: number;
  actor_email: string;
  action: string;
  target: string;
  detail: string;
  at: string;
}

export interface RoleInfo {
  name: Role;
  description: string;
}

export interface RegistrationStatus {
  open: boolean;
}

// ── onboarding ────────────────────────────────────────────────────────────────
export interface ConnectRequest {
  display_name: string;
  system_id?: string | null;
  owner?: string;
  location?: string;
  environment?: string;
}

export interface ConnectResponse {
  system_id: string;
  display_name: string;
  /** The single line a user pastes into PowerShell. */
  install_command: string;
  /** Fallback for people who prefer running the steps themselves. */
  manual_commands: string;
  api_key: string;
  expires_at: string;
}

export interface SystemStatus {
  system_id: string;
  display_name: string;
  status: "online" | "offline";
  last_seen_at: string | null;
  last_sync_at: string | null;
  total_events: number;
  never_synced: boolean;
}

export interface CreateUserPayload {
  email: string;
  full_name?: string;
  role: Role;
  system_ids?: string[];
  /** Omit to send an email invite instead of setting a password directly. */
  password?: string;
}

/** POST /admin/users — the created user plus how they can get in. */
export interface CreatedUser extends User {
  invited: boolean;
  /** Starter password mailed with the invite; absent when a password was set. */
  default_password?: string;
}

export interface UpdateUserPayload {
  full_name?: string | null;
  password?: string | null;
  role?: Role | null;
  is_active?: boolean | null;
  system_ids?: string[] | null;
}

// ── Claude subscription accounts ──────────────────────────────────────────────
export type AccountHealth = "healthy" | "moderate" | "heavy" | "unknown";

export interface AccountSystemRef {
  system_id: string;
  display_name: string;
  status: string;
}

export interface AccountUserRef {
  id: number;
  email: string;
  full_name: string;
  /** This person's machines on this account. */
  systems: AccountSystemRef[];
  /**
   * Usage of that person's machines. A machine shared by two people counts for
   * both, so these describe attribution and need not sum to the account total.
   */
  tokens_today: number;
  tokens_week: number;
  /** Portion of the week's tokens across the people on this account, 0–100. */
  share_percent: number;
}

export interface BillingDates {
  /** Next monthly anniversary of the subscription start. Always an estimate. */
  next_renewal_at: string | null;
  is_estimate: boolean;
  /** Real pay-by date while a trial runs; null once it has passed. */
  trial_ends_at: string | null;
  days_until: number | null;
}

export interface AccountRow {
  id: number;
  account_uuid: string;
  email_address: string;
  display_name: string;
  organization_name: string;
  plan_label: string;
  plan_family: string;
  has_extra_usage_enabled: boolean;
  /** online = a bound PC is live; idle = bound but quiet; offline = unbound. */
  status: "online" | "idle" | "offline";
  health: AccountHealth;
  weekly_percent: number | null;
  weekly_resets_at: string | null;
  session_percent: number | null;
  session_resets_at: string | null;
  /** Claude Code cached these figures — they can lag reality. */
  utilization_fetched_at: string | null;
  systems: AccountSystemRef[];
  /** Everyone on this subscription, heaviest first. */
  users: AccountUserRef[];
  /** Bound machines with no owner — their usage counts, but belongs to nobody. */
  unassigned_systems: AccountSystemRef[];
  /** More than one person shares this Claude subscription. */
  is_shared: boolean;
  /** Heaviest user this week; null unless the account is shared. */
  top_user: { id: number; name: string; tokens_week: number; share_percent: number } | null;
  billing: BillingDates;
  seat_tier: string;
  tokens_today: number;
  tokens_week: number;
  last_seen_at: string | null;
}

export interface AccountSummary {
  total_accounts: number;
  by_family: Record<string, number>;
  in_use: number;
  idle: number;
  heaviest: { account_uuid: string; email_address: string; percent: number } | null;
}

export interface AccountsResponse {
  accounts: AccountRow[];
  summary: AccountSummary;
  scoped: boolean;
}

// ── people (master-detail session view) ───────────────────────────────────────
export interface PersonRow {
  id: number;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  status: "online" | "offline";
  system_count: number;
  account_email: string | null;
  account_org_type: string | null;
  account_rate_limit_tier: string | null;
  plan_label: string | null;
  tokens_today: number;
  tokens_range: number;
  sessions: number;
  projects: number;
  /** null when this window predates prompt collection - render as an em dash. */
  prompts: number | null;
  last_active: string | null;
  /** Live agent state from this person's most recently reporting machine. */
  scan: ScanActivity;
}

/** The shared live-agent shape: also spread onto SystemRow, per machine. */
export interface ScanActivity {
  agent_state: AgentState;
  agent_state_at: string | null;
  agent_state_detail: string;
  scanning: boolean;
  scan_interval_seconds: number | null;
  last_scan_at: string | null;
  last_scan_duration_ms: number | null;
  next_scan_due_at: string | null;
  server_time: string;
}

export interface PeopleResponse {
  people: PersonRow[];
  range: string;
}

export interface PersonProject {
  project_name: string;
  sessions: number;
  total_tokens: number;
}

export interface PersonDetail {
  person: PersonRow;
  projects: PersonProject[];
  timeseries: { day: string; total_tokens: number }[];
  range: string;
}

export interface PersonSessionRow {
  session_id: string;
  system_id: string;
  system_name: string;
  project_name: string;
  model: string;
  title: string | null;
  first_ts: string;
  last_ts: string;
  prompts: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  total_tokens: number;
}

export interface PersonSessionsResponse {
  sessions: PersonSessionRow[];
  total: number;
  page: number;
  page_size: number;
  page_count: number;
}
