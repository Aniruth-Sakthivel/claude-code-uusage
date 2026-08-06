/**
 * The live "is this agent actually working?" view for one machine.
 *
 * `lastSeenAt` answers "did something check in recently", which looks identical
 * whether the agent is mid-scan, idle between scans, or wedged. The agent
 * instead reports each step of its cycle (scanning → scanned → syncing → idle)
 * and this turns those reports into what the Systems table renders.
 *
 * Kept out of the service layer so the staleness rule is unit-testable without
 * a database — the same reason agentHealth.ts exists.
 */

export type AgentState =
  | "unknown"
  | "idle"
  | "scanning"
  | "scanned"
  | "syncing"
  | "paused"
  | "stopped"
  | "error";

/**
 * States that stay true however long ago they were reported.
 *
 * `stopped` is a finished outcome, not work in progress: the agent scanned,
 * synced, said it was leaving, and exited because no Claude Code session is
 * open. Ageing it out into `unknown` after ten minutes would erase the only
 * evidence that an idle machine is idle *on purpose*.
 */
const TERMINAL: AgentState[] = ["stopped"];

/**
 * How long a reported state is believed.
 *
 * A scan that started and never finished must not render as "Scanning…"
 * indefinitely: that reads as a healthy agent when it means the opposite. Past
 * this age the state is reported as unknown and the row falls back to
 * check-in-based health. Comfortably longer than any real scan, short enough
 * that a killed agent stops looking busy within minutes.
 */
export const STATE_TRUSTED_FOR_MS = 10 * 60_000;

export interface ScanActivityInput {
  agentStatus: string;
  agentStatusAt: Date | null;
  agentStatusDetail: string;
  scanIntervalSeconds: number | null;
  lastScanAt: Date | null;
  lastScanDurationMs: number | null;
}

export interface ScanActivityView {
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

const KNOWN: AgentState[] = [
  "idle",
  "scanning",
  "scanned",
  "syncing",
  "paused",
  "stopped",
  "error",
];

export function deriveScanActivity(
  s: ScanActivityInput,
  now: Date = new Date(),
): ScanActivityView {
  const reportedAt = s.agentStatusAt;
  const state = KNOWN.includes(s.agentStatus as AgentState)
    ? (s.agentStatus as AgentState)
    : "unknown";

  const fresh =
    state !== "unknown" &&
    !!reportedAt &&
    (TERMINAL.includes(state) ||
      now.getTime() - reportedAt.getTime() <= STATE_TRUSTED_FOR_MS);

  const interval = s.scanIntervalSeconds ?? null;
  // Only meaningful for an agent that is actually scanning on a timer. A
  // stopped agent has no next scan to count down to — it resumes when someone
  // opens Claude Code, and a countdown ticking past zero on an idle machine
  // would read as an agent that is overdue rather than one that is off.
  const nextDue =
    interval && s.lastScanAt && state !== "stopped"
      ? new Date(s.lastScanAt.getTime() + interval * 1000)
      : null;

  return {
    agent_state: fresh ? state : "unknown",
    agent_state_at: reportedAt?.toISOString() ?? null,
    agent_state_detail: fresh ? s.agentStatusDetail : "",
    scanning: fresh && (state === "scanning" || state === "syncing"),
    scan_interval_seconds: interval,
    last_scan_at: s.lastScanAt?.toISOString() ?? null,
    last_scan_duration_ms: s.lastScanDurationMs,
    next_scan_due_at: nextDue?.toISOString() ?? null,
    server_time: now.toISOString(),
  };
}
