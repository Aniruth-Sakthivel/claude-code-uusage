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
 * supported cadence — the daily catch-up task. The agent checks in far more
 * often while a session is open, so these bounds are safe for both.
 *
 *   never   never checked in at all — set up, but not yet running
 *   dormant finished cleanly and exited; nobody is using Claude Code
 *   healthy heard from within one expected cycle
 *   late    missed a cycle; usually a sleeping laptop or a slow sync
 *   stalled hours of silence while it was recently active — treat as stuck
 *   dead    no contact for over a day
 *
 * `dormant` is the one that makes the event-driven agent legible. The agent
 * runs only while a Claude Code session is open and reports `stopped` on its
 * way out, so on a normal machine silence is the *resting* state — most of
 * every night and weekend. Grading that as stalled and then dead would fire an
 * alarm on every well-behaved PC in the fleet. A machine is only judged by
 * elapsed silence when it never said it was stopping.
 */

export type AgentHealth = "never" | "dormant" | "healthy" | "late" | "stalled" | "dead";

/** The terminal state an agent reports as it exits cleanly. */
export const STOPPED_STATE = "stopped";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * An agent mid-session reports several times a minute; these bounds only judge
 * one that went quiet *without* saying it stopped, so they stay generous.
 */
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
  agentStatus: string | null = null,
): AgentHealthView {
  // Checked before the staleness ladder, and deliberately not time-bounded: an
  // agent that reported `stopped` is not overdue for anything. It will report
  // again when someone next opens Claude Code, which may be Monday.
  if (lastSeenAt && agentStatus === STOPPED_STATE) {
    const seen = lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
    if (!Number.isNaN(seen.getTime())) {
      return {
        health: "dormant",
        silent_for_ms: Math.max(0, now.getTime() - seen.getTime()),
        reason: "Idle — no Claude Code session open. Starts again on its own.",
      };
    }
  }

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
        "Silent for hours without reporting that it stopped. The agent may have been killed mid-session.",
    };
  }
  return {
    health: "dead",
    silent_for_ms: silent,
    reason: "No contact for over a day. The agent is not running on that PC.",
  };
}
