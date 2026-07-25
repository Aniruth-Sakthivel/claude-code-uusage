/**
 * API contract types — mirror the Zod schemas in api/src/schemas/index.ts.
 * Keep them in sync when the backend contract changes.
 */

export type Role = "admin" | "manager" | "developer" | "viewer";

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

export interface SystemRow {
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
  total_tokens: number;
  sessions: number;
  projects: number;
  /** True until the agent's first successful sync — drives the setup hint. */
  never_synced: boolean;
}

export interface SystemCreated {
  system: SystemRow;
  api_key: string;
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
  /** Direct download link for the standalone claudefleet.exe, no command needed. */
  exe_url: string;
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

export interface UpdateUserPayload {
  full_name?: string | null;
  password?: string | null;
  role?: Role | null;
  is_active?: boolean | null;
  system_ids?: string[] | null;
}
