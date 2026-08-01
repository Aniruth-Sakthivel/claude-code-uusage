import { describe, expect, it } from "vitest";

import { deriveHealth, derivePlan } from "./plans.js";

describe("derivePlan", () => {
  it("labels the real values observed in production", () => {
    // Verified against a live ~/.claude.json.
    expect(derivePlan("claude_max", "default_claude_max_5x")).toEqual({
      label: "Max 5x",
      family: "max",
    });
  });

  it("handles the other Max multiplier", () => {
    expect(derivePlan("claude_max", "default_claude_max_20x").label).toBe("Max 20x");
  });

  it("ignores the tier prefix, which has changed before", () => {
    expect(derivePlan("claude_max", "legacy_claude_max_5x").label).toBe("Max 5x");
  });

  it("falls back to plain Max when the multiplier is unrecognised", () => {
    expect(derivePlan("claude_max", "something_new").label).toBe("Max");
  });

  it("labels non-Max families", () => {
    expect(derivePlan("claude_pro", "")).toEqual({ label: "Pro", family: "pro" });
    expect(derivePlan("claude_team", "")).toEqual({ label: "Team", family: "team" });
  });

  it("shows an unknown org type rather than guessing", () => {
    const plan = derivePlan("claude_platinum", "whatever");
    expect(plan.family).toBe("unknown");
    expect(plan.label).toBe("Platinum"); // visible as unfamiliar, not mislabelled
  });

  it("survives empty and malformed input", () => {
    expect(derivePlan("", "")).toEqual({ label: "Unknown", family: "unknown" });
    expect(derivePlan(undefined as never, undefined as never).family).toBe("unknown");
  });

  it("is case insensitive", () => {
    expect(derivePlan("CLAUDE_MAX", "DEFAULT_CLAUDE_MAX_5X").label).toBe("Max 5x");
  });
});

describe("deriveHealth", () => {
  it("prefers Anthropic's own severity over our thresholds", () => {
    // 95% would be "heavy" by percentage, but Anthropic says it is fine.
    expect(deriveHealth("normal", 95)).toBe("healthy");
    expect(deriveHealth("critical", 2)).toBe("heavy");
  });

  it("falls back to percentage when severity is unrecognised", () => {
    expect(deriveHealth("", 10)).toBe("healthy");
    expect(deriveHealth("", 75)).toBe("moderate");
    expect(deriveHealth("", 92)).toBe("heavy");
    expect(deriveHealth("brand_new_value", 92)).toBe("heavy");
  });

  it("reports unknown when there is nothing to go on", () => {
    expect(deriveHealth("", null)).toBe("unknown");
    expect(deriveHealth("", Number.NaN)).toBe("unknown");
  });
});
