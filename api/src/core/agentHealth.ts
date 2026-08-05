/**
 * Is this machine's agent actually alive?
 *
 * "Online / offline" could not answer the question people actually ask after
 * closing a terminal: *is it still sending?* A binary flag flips to offline the
 * moment a 10-minute window lapses, which looks identical for a laptop that is
 * merely asleep, an agent that died when its window closed, and a machine
 * decommissioned last month.
 *
 * So liveness is graded by how overdue the agent is, against the slowest
 * supported cadence — the 15-minute scheduled scan+sync. The daemon checks in
 * far more often, so these bounds are safe for both.
 *
 *   never   never checked in at all — set up, but not yet running
 *   healthy heard from within one expected cycle
 *   late    missed a cycle; usually a sleeping laptop or a slow sync
 *   stalled hours of silence while it was recently active — treat as stuck
 *   dead    no contact for over a day
 */

export type AgentHealth = "never" | "healthy" | "late" | "stalled" | "dead";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The scheduled task runs every 15 minutes; allow a cycle plus slack. */
export const HEALTHY_WITHIN_MS = 20 * MINUTE;
export const LATE_WITHIN_MS = 2 * HOUR;
export const STALLED_WITHIN_MS = 24 * HOUR;

export interface AgentHealthView {
  health: AgentHealth;
  /** Milliseconds since the last contact; null when it has never checked in. */
  silent_for_ms: number | null;
  /** One line the UI can show verbatim. */
  reason: string;
}

export function deriveAgentHealth(
  lastSeenAt: Date | string | null,
  now: Date = new Date(),
): AgentHealthView {
  if (!lastSeenAt) {
    return {
      health: "never",
      silent_for_ms: null,
      reason: "Registered, but has never checked in. Run scan and sync on that PC.",
    };
  }

  const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(seen.getTime())) {
    return { health: "never", silent_for_ms: null, reason: "No valid check-in recorded." };
  }

  // A clock skewed slightly ahead must not read as "silent for -3 minutes".
  const silent = Math.max(0, now.getTime() - seen.getTime());

  if (silent <= HEALTHY_WITHIN_MS) {
    return { health: "healthy", silent_for_ms: silent, reason: "Reporting normally." };
  }
  if (silent <= LATE_WITHIN_MS) {
    return {
      health: "late",
      silent_for_ms: silent,
      reason: "Missed its last check-in. Usually a PC that is asleep or offline.",
    };
  }
  if (silent <= STALLED_WITHIN_MS) {
    return {
      health: "stalled",
      silent_for_ms: silent,
      reason:
        "Silent for hours. The agent may have stopped — a foreground daemon ends when its terminal closes.",
    };
  }
  return {
    health: "dead",
    silent_for_ms: silent,
    reason: "No contact for over a day. The agent is not running on that PC.",
  };
}
