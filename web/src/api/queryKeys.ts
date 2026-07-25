/**
 * Central query-key registry.
 *
 * Keys were previously string literals scattered across seven files, which made
 * invalidation easy to get wrong — creating a system never refreshed the
 * dashboard totals, for instance.
 */

export const qk = {
  me: ["me"] as const,
  registrationOpen: ["registration-open"] as const,

  systems: ["systems"] as const,
  systemStatus: (id: string) => ["system-status", id] as const,

  summary: ["summary"] as const,
  ranking: (range: string) => ["ranking", range] as const,
  timeseries: (range: string) => ["timeseries", range] as const,

  projects: ["projects"] as const,
  sessions: ["sessions"] as const,

  users: ["users"] as const,
  roles: ["roles"] as const,
  keys: (systemId: string | null) => ["keys", systemId] as const,
  audit: ["audit"] as const,
};

/** Everything that changes when systems or usage data change. */
export const fleetKeys = [qk.systems, qk.summary, qk.projects, qk.sessions];
