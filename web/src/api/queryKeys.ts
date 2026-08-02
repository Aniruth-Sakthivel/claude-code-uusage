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
  commands: (systemId: string | null) => ["commands", systemId] as const,

  initiatives: ["initiatives"] as const,
  initiative: (id: number) => ["initiative", id] as const,
  milestones: (initiativeId: number) => ["milestones", initiativeId] as const,
  tasks: (initiativeId: number) => ["tasks", initiativeId] as const,
  task: (id: number) => ["task", id] as const,
  taskComments: (taskId: number) => ["task-comments", taskId] as const,
  docs: (initiativeId: number) => ["docs", initiativeId] as const,
  doc: (id: number) => ["doc", id] as const,
  activity: (initiativeId: number) => ["activity", initiativeId] as const,
  assignees: ["assignees"] as const,
  notifications: ["notifications"] as const,
  unreadCount: ["unread-count"] as const,
  channels: ["channels"] as const,
  channelMessages: (channelId: number) => ["channel-messages", channelId] as const,
  calendar: ["calendar"] as const,
  search: (q: string) => ["search", q] as const,
  reports: ["reports"] as const,
  wiki: ["wiki"] as const,
  automations: ["automations"] as const,
  automationRuns: ["automation-runs"] as const,
  boards: ["boards"] as const,
  initiativeClients: (initiativeId: number) => ["initiative-clients", initiativeId] as const,
  clientDirectory: ["client-directory"] as const,
  sharedInitiatives: ["shared-initiatives"] as const,
  boardElements: (boardId: number) => ["board-elements", boardId] as const,
  audit: ["audit"] as const,
  accounts: ["accounts"] as const,
  settings: ["settings"] as const,
  preferences: ["preferences"] as const,
  people: (range: string) => ["people", range] as const,
  person: (id: number, range: string) => ["person", id, range] as const,
  personSessions: (id: number, range: string, project: string, status: string, page: number) =>
    ["person-sessions", id, range, project, status, page] as const,
};

/** Everything that changes when systems or usage data change. */
export const fleetKeys = [qk.systems, qk.summary, qk.projects, qk.sessions, qk.accounts];
