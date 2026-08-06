import { describe, expect, it } from "vitest";

import { deriveAgentHealth } from "./agentHealth.js";

const now = new Date("2026-08-05T12:00:00Z");
const agoMinutes = (m: number) => new Date(now.getTime() - m * 60_000);

describe("deriveAgentHealth", () => {
  it("reports never for a machine that has not checked in", () => {
    const v = deriveAgentHealth(null, now);
    expect(v.health).toBe("never");
    expect(v.silent_for_ms).toBeNull();
    expect(v.reason).toMatch(/never checked in/i);
  });

  it("is healthy just after a check-in", () => {
    expect(deriveAgentHealth(agoMinutes(1), now).health).toBe("healthy");
  });

  describe("dormant — the agent stopped because nobody is using Claude Code", () => {
    it("reports dormant when the last word was a clean stop", () => {
      const v = deriveAgentHealth(agoMinutes(30), now, "stopped");
      expect(v.health).toBe("dormant");
      expect(v.reason).toMatch(/no Claude Code session/i);
    });

    /**
     * The whole point: an agent that only runs during sessions is silent all
     * night and all weekend. Ageing that into "dead" would alarm on every
     * healthy PC in the fleet.
     */
    it("stays dormant no matter how long the silence lasts", () => {
      expect(deriveAgentHealth(agoMinutes(3 * 24 * 60), now, "stopped").health).toBe("dormant");
    });

    it("still reports how long it has been quiet", () => {
      expect(deriveAgentHealth(agoMinutes(45), now, "stopped").silent_for_ms).toBe(45 * 60_000);
    });

    /** Silence with no clean stop is the case that genuinely needs an alarm. */
    it("does not excuse silence from an agent that never said it stopped", () => {
      expect(deriveAgentHealth(agoMinutes(30 * 60), now, "scanning").health).toBe("dead");
      expect(deriveAgentHealth(agoMinutes(30 * 60), now, null).health).toBe("dead");
    });

    it("prefers never over dormant when it has never checked in", () => {
      expect(deriveAgentHealth(null, now, "stopped").health).toBe("never");
    });
  });

  /** The scheduled task runs every 15 minutes, so 18 must not read as broken. */
  it("stays healthy across a normal 15-minute gap", () => {
    expect(deriveAgentHealth(agoMinutes(18), now).health).toBe("healthy");
  });

  it("turns late once a cycle is missed", () => {
    expect(deriveAgentHealth(agoMinutes(45), now).health).toBe("late");
  });

  it("is stalled after hours of silence", () => {
    const v = deriveAgentHealth(agoMinutes(6 * 60), now);
    expect(v.health).toBe("stalled");
    // The case that still deserves attention: quiet, but it never reported
    // stopping — so it was killed rather than finishing a session.
    expect(v.reason).toMatch(/without reporting that it stopped/i);
  });

  it("is dead after more than a day", () => {
    expect(deriveAgentHealth(agoMinutes(30 * 60), now).health).toBe("dead");
  });

  it("reports how long it has been silent", () => {
    expect(deriveAgentHealth(agoMinutes(30), now).silent_for_ms).toBe(30 * 60_000);
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(deriveAgentHealth(agoMinutes(2).toISOString(), now).health).toBe("healthy");
  });

  /** A slightly fast client clock must not produce a negative duration. */
  it("clamps a future timestamp to zero rather than going negative", () => {
    const v = deriveAgentHealth(new Date(now.getTime() + 90_000), now);
    expect(v.silent_for_ms).toBe(0);
    expect(v.health).toBe("healthy");
  });

  it("treats an unparseable timestamp as never", () => {
    expect(deriveAgentHealth("not-a-date", now).health).toBe("never");
  });

  it("places each boundary in the lower-severity band", () => {
    expect(deriveAgentHealth(agoMinutes(20), now).health).toBe("healthy");
    expect(deriveAgentHealth(agoMinutes(120), now).health).toBe("late");
    expect(deriveAgentHealth(agoMinutes(24 * 60), now).health).toBe("stalled");
  });
});
