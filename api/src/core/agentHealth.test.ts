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
    // The exact case someone hits after closing the terminal.
    expect(v.reason).toMatch(/terminal closes/i);
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
