import { describe, expect, it } from "vitest";

import { SETTING_DEFAULTS, SETTING_KEYS, parseSettings, toRows } from "./settings.js";

describe("parseSettings", () => {
  it("returns defaults for an empty table", () => {
    expect(parseSettings([])).toEqual(SETTING_DEFAULTS);
  });

  it("reads stored values", () => {
    const parsed = parseSettings([
      { key: SETTING_KEYS.registrationOpen, value: "false" },
      { key: SETTING_KEYS.defaultRole, value: "viewer" },
      { key: SETTING_KEYS.retentionDays, value: "90" },
    ]);
    expect(parsed.registrationOpen).toBe(false);
    expect(parsed.defaultRole).toBe("viewer");
    expect(parsed.retentionDays).toBe(90);
  });

  it("falls back when a role is not a real role", () => {
    // A hand-edited row must not grant an unknown role.
    const parsed = parseSettings([{ key: SETTING_KEYS.defaultRole, value: "superuser" }]);
    expect(parsed.defaultRole).toBe(SETTING_DEFAULTS.defaultRole);
  });

  it("falls back on unparseable numbers", () => {
    const parsed = parseSettings([{ key: SETTING_KEYS.retentionDays, value: "not a number" }]);
    expect(parsed.retentionDays).toBe(SETTING_DEFAULTS.retentionDays);
  });

  it("clamps numbers into range", () => {
    const parsed = parseSettings([
      { key: SETTING_KEYS.retentionDays, value: "999999" },
      { key: SETTING_KEYS.healthModeratePct, value: "-5" },
    ]);
    expect(parsed.retentionDays).toBe(3650);
    expect(parsed.healthModeratePct).toBeGreaterThanOrEqual(1);
  });

  it("keeps the health thresholds ordered", () => {
    // Moderate at or above heavy would make "heavy" unreachable.
    const parsed = parseSettings([
      { key: SETTING_KEYS.healthModeratePct, value: "95" },
      { key: SETTING_KEYS.healthHeavyPct, value: "80" },
    ]);
    expect(parsed.healthModeratePct).toBeLessThan(parsed.healthHeavyPct);
    expect(parsed.healthHeavyPct).toBe(80);
  });

  it("round-trips through toRows", () => {
    const original = {
      ...SETTING_DEFAULTS,
      registrationOpen: false,
      defaultRole: "manager" as const,
      retentionDays: 30,
    };
    expect(parseSettings(toRows(original))).toEqual(original);
  });
});
