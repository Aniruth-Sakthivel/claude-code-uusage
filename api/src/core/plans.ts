/**
 * Claude plan labels.
 *
 * Anthropic reports two raw strings — `organizationType` ("claude_max") and
 * `organizationRateLimitTier` ("default_claude_max_5x") — that are internal
 * identifiers with no compatibility promise. Both are stored verbatim; this
 * module is the single place that turns them into something a human reads.
 *
 * The rule everywhere below: an unrecognised value degrades to showing the raw
 * string, never to a wrong label and never to a crash. A new tier appearing in
 * production should look unfamiliar in the UI, not silently masquerade as the
 * wrong plan.
 */

export type PlanFamily = "pro" | "max" | "team" | "enterprise" | "free" | "unknown";

export interface PlanInfo {
  /** Human label for a badge, e.g. "Max 5x". */
  label: string;
  /** Coarse grouping for counting and filtering. */
  family: PlanFamily;
}

const FAMILY_BY_ORG_TYPE: Record<string, PlanFamily> = {
  claude_pro: "pro",
  claude_max: "max",
  claude_team: "team",
  claude_enterprise: "enterprise",
  claude_free: "free",
};

/**
 * Multiplier suffixes seen on Max tiers. Matched loosely because the prefix
 * ("default_", "legacy_", …) has changed before and is not meaningful here.
 */
const MAX_MULTIPLIERS: [RegExp, string][] = [
  [/_20x\b/, "20x"],
  [/_5x\b/, "5x"],
];

function titleCase(raw: string): string {
  return raw
    .replace(/^claude[_-]/, "")
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function derivePlan(organizationType: string, rateLimitTier: string): PlanInfo {
  const orgType = (organizationType ?? "").trim().toLowerCase();
  const tier = (rateLimitTier ?? "").trim().toLowerCase();
  const family = FAMILY_BY_ORG_TYPE[orgType] ?? "unknown";

  if (family === "max") {
    for (const [pattern, multiplier] of MAX_MULTIPLIERS) {
      if (pattern.test(tier)) return { label: `Max ${multiplier}`, family };
    }
    return { label: "Max", family };
  }

  if (family !== "unknown") {
    return { label: titleCase(orgType), family };
  }

  // Unrecognised: show the raw value so the gap is visible, rather than
  // guessing. An empty value means the agent has not reported yet.
  return { label: orgType ? titleCase(orgType) : "Unknown", family: "unknown" };
}

/**
 * Anthropic's own severity verdict, normalised for the UI.
 *
 * Reported per rate-limit window as `severity`. Using it means the health
 * indicator reflects Anthropic's thresholds rather than ones we invented; the
 * percentage fallback only applies when severity is absent or unrecognised.
 */
export type Health = "healthy" | "moderate" | "heavy" | "unknown";

const HEALTH_BY_SEVERITY: Record<string, Health> = {
  normal: "healthy",
  warning: "moderate",
  warn: "moderate",
  moderate: "moderate",
  critical: "heavy",
  severe: "heavy",
  exceeded: "heavy",
};

export function deriveHealth(severity: string, percent: number | null): Health {
  const known = HEALTH_BY_SEVERITY[(severity ?? "").trim().toLowerCase()];
  if (known) return known;
  if (percent === null || Number.isNaN(percent)) return "unknown";
  if (percent >= 90) return "heavy";
  if (percent >= 70) return "moderate";
  return "healthy";
}
