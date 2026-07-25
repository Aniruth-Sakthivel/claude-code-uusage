import { describe, expect, it } from "vitest";

import { agentMessageIn, dashboardMessageIn } from "./protocol.js";

describe("agentMessageIn", () => {
  it("accepts a valid heartbeat", () => {
    expect(agentMessageIn.safeParse({ type: "heartbeat" }).success).toBe(true);
  });

  it("accepts a valid scan_result", () => {
    const result = agentMessageIn.safeParse({
      type: "scan_result",
      trigger: "schedule",
      duration_ms: 120.5,
      day: "2026-07-25",
      new: 1,
      updated: 0,
      skipped: 3,
      events_inserted: 4,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(agentMessageIn.safeParse({ type: "shutdown_server" }).success).toBe(false);
  });

  it("rejects a malformed day", () => {
    const result = agentMessageIn.safeParse({
      type: "scan_result",
      duration_ms: 1,
      day: "not-a-date",
      new: 0,
      updated: 0,
      skipped: 0,
      events_inserted: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative duration", () => {
    const result = agentMessageIn.safeParse({
      type: "scan_result",
      duration_ms: -5,
      day: "2026-07-25",
      new: 0,
      updated: 0,
      skipped: 0,
      events_inserted: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized sync batch", () => {
    const events = Array.from({ length: 1001 }, (_, i) => ({
      suffix: `s${i}`,
      session_id: "sess",
      day: "2026-07-25",
    }));
    const result = agentMessageIn.safeParse({ type: "sync", events });
    expect(result.success).toBe(false);
  });

  it("rejects a plain string alert message that is too long", () => {
    const result = agentMessageIn.safeParse({
      type: "alert",
      level: "error",
      message: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid alert level", () => {
    const result = agentMessageIn.safeParse({
      type: "alert",
      level: "catastrophic",
      message: "oops",
    });
    expect(result.success).toBe(false);
  });
});

describe("dashboardMessageIn", () => {
  it("accepts ping", () => {
    expect(dashboardMessageIn.safeParse({ type: "ping" }).success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(dashboardMessageIn.safeParse({ type: "subscribe", system_id: "x" }).success).toBe(
      false,
    );
  });
});
