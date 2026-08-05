import { describe, expect, it } from "vitest";

import { alertBody, alertTitle, alertsForReading, type LimitReading } from "./limitAlerts.js";

const reading = (percent: number, kind = "weekly_all"): LimitReading => ({
  kind,
  scopeLabel: kind === "session" ? "5-hour window" : "weekly (all models)",
  percent,
});

describe("alertsForReading", () => {
  it("stays silent below every threshold", () => {
    expect(alertsForReading([reading(79)], new Map([["weekly_all", 40]]))).toEqual([]);
  });

  it("alerts when a reading crosses 80", () => {
    const alerts = alertsForReading([reading(82)], new Map([["weekly_all", 78]]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ threshold: 80, level: "warning", percent: 82 });
  });

  /** The reason this module exists: the agent re-reports every cycle. */
  it("does not repeat while the reading climbs inside the same band", () => {
    expect(alertsForReading([reading(85)], new Map([["weekly_all", 82]]))).toEqual([]);
    expect(alertsForReading([reading(94)], new Map([["weekly_all", 85]]))).toEqual([]);
  });

  it("alerts again when it escalates into the next band", () => {
    const alerts = alertsForReading([reading(96)], new Map([["weekly_all", 85]]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ threshold: 95, level: "error" });
  });

  it("stays silent while it climbs inside the top band", () => {
    expect(alertsForReading([reading(99)], new Map([["weekly_all", 96]]))).toEqual([]);
  });

  it("says nothing when usage falls", () => {
    expect(alertsForReading([reading(81)], new Map([["weekly_all", 97]]))).toEqual([]);
    expect(alertsForReading([reading(10)], new Map([["weekly_all", 97]]))).toEqual([]);
  });

  it("alerts again after a window reset takes it back under and over", () => {
    // Reset dropped it to 4; the next climb is a genuine new crossing.
    const alerts = alertsForReading([reading(81)], new Map([["weekly_all", 4]]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.threshold).toBe(80);
  });

  it("alerts on a first-ever reading that is already over", () => {
    const alerts = alertsForReading([reading(97)], new Map());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ threshold: 95, level: "error" });
  });

  it("tracks each window independently", () => {
    const alerts = alertsForReading(
      [reading(96, "session"), reading(83, "weekly_all")],
      new Map([
        ["session", 50],
        ["weekly_all", 82],
      ]),
    );
    // session crossed into 95; weekly was already in the 80 band.
    expect(alerts.map((a) => a.kind)).toEqual(["session"]);
  });

  it("skips a non-numeric percent rather than alerting on NaN", () => {
    expect(alertsForReading([reading(Number.NaN)], new Map())).toEqual([]);
  });

  it("treats exactly 80 and exactly 95 as crossings", () => {
    expect(alertsForReading([reading(80)], new Map([["weekly_all", 79]]))[0]?.threshold).toBe(80);
    expect(alertsForReading([reading(95)], new Map([["weekly_all", 94]]))[0]?.threshold).toBe(95);
  });
});

describe("alert copy", () => {
  it("names the window and the figure", () => {
    const [a] = alertsForReading([reading(96, "session")], new Map());
    expect(alertTitle(a!)).toBe("Claude limit at 96% — 5-hour window");
    expect(alertBody(a!, "dev@example.com")).toContain("may stop shortly");
  });

  it("is calmer at the lower threshold", () => {
    const [a] = alertsForReading([reading(81)], new Map());
    expect(alertBody(a!, "dev@example.com")).toContain("passed 80%");
    expect(alertBody(a!, "dev@example.com")).not.toContain("stop shortly");
  });
});
