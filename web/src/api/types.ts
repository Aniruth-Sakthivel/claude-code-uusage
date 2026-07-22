export type Role = "admin" | "manager" | "developer" | "viewer";

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  system_ids: string[];
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
  created_at: string;
  status: "online" | "offline" | "unknown";
  total_tokens: number;
  sessions: number;
  projects: number;
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
}

export interface TimeseriesPoint { day: string; values: Record<string, number>; }
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

export interface AuditRow {
  id: number;
  actor_email: string;
  action: string;
  target: string;
  detail: string;
  at: string;
}
