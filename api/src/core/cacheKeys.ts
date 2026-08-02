/**
 * Structured cache keys and invalidation tags — the single source of truth
 * for both, so a key never gets typo'd differently at the read site vs. the
 * invalidation site (which would silently defeat invalidation).
 *
 * Only genuinely global (not per-user-scoped) data belongs here — see the
 * warning in cache.ts. Most of this app's GET routes (dashboard, systems,
 * sessions, projects) are scoped by the caller's role/visible-systems and
 * are deliberately NOT cached: a flat key would leak data across users, and
 * the product's core value is *live* usage tracking, where even a
 * short-lived stale read is the wrong tradeoff.
 */

export const CacheKeys = {
  /** The one fleet-wide settings row — same for every caller who can see it. */
  fleetSettings: () => "settings:fleet",
  /** Whether self-service signup is open — public, global, checked on every load. */
  registrationOpen: () => "auth:registration-open",
} as const;

export const CacheTags = {
  SETTINGS: "settings",
  AUTH: "auth",
} as const;
