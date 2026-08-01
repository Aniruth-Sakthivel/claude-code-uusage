/**
 * Fleet settings: the typed contract over the `app_settings` key/value table.
 *
 * Every setting has a default here, so a fresh install and a partially-written
 * table both behave. Reads coerce and clamp rather than trusting the stored
 * string — a hand-edited row should degrade to the default, not break a page.
 */

import { ROLES, type Role } from "./rbac.js";

export interface FleetSettings {
  /** Whether self-service signup is accepted. */
  registrationOpen: boolean;
  /** Role assigned to users who sign themselves up. */
  defaultRole: Role;
  /**
   * Fallback utilization thresholds for the health indicator. Anthropic's own
   * `severity` is preferred where present; these only apply when it is absent
   * or unrecognised — see core/plans.ts.
   */
  healthModeratePct: number;
  healthHeavyPct: number;
  /**
   * Days of usage history to keep. 0 means keep everything.
   *
   * NOTE: nothing enforces this automatically. There is no scheduler in the
   * API, so retention only happens when an admin runs the purge, or when an
   * external cron calls it. The settings UI says so plainly rather than
   * implying data is being cleaned up on its own.
   */
  retentionDays: number;
}

export const SETTING_DEFAULTS: FleetSettings = {
  registrationOpen: true,
  defaultRole: "developer",
  healthModeratePct: 70,
  healthHeavyPct: 90,
  retentionDays: 0,
};

/** Storage keys, kept stable and separate from the field names. */
export const SETTING_KEYS: Record<keyof FleetSettings, string> = {
  registrationOpen: "registration_open",
  defaultRole: "default_role",
  healthModeratePct: "health_moderate_pct",
  healthHeavyPct: "health_heavy_pct",
  retentionDays: "retention_days",
};

function toBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

function toInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** Build a settings object from raw rows, filling and clamping as needed. */
export function parseSettings(rows: { key: string; value: string }[]): FleetSettings {
  const raw = new Map(rows.map((r) => [r.key, r.value]));
  const defaultRole = raw.get(SETTING_KEYS.defaultRole);

  const settings: FleetSettings = {
    registrationOpen: toBool(raw.get(SETTING_KEYS.registrationOpen), SETTING_DEFAULTS.registrationOpen),
    defaultRole: (ROLES as readonly string[]).includes(defaultRole ?? "")
      ? (defaultRole as Role)
      : SETTING_DEFAULTS.defaultRole,
    healthModeratePct: toInt(raw.get(SETTING_KEYS.healthModeratePct), SETTING_DEFAULTS.healthModeratePct, 1, 99),
    healthHeavyPct: toInt(raw.get(SETTING_KEYS.healthHeavyPct), SETTING_DEFAULTS.healthHeavyPct, 2, 100),
    retentionDays: toInt(raw.get(SETTING_KEYS.retentionDays), SETTING_DEFAULTS.retentionDays, 0, 3650),
  };

  // A moderate threshold at or above the heavy one would make "heavy"
  // unreachable. Rather than reject the save, keep them ordered.
  if (settings.healthModeratePct >= settings.healthHeavyPct) {
    settings.healthModeratePct = Math.max(1, settings.healthHeavyPct - 1);
  }
  return settings;
}

/** Serialize for storage — the inverse of `parseSettings`. */
export function toRows(settings: FleetSettings): { key: string; value: string }[] {
  return [
    { key: SETTING_KEYS.registrationOpen, value: String(settings.registrationOpen) },
    { key: SETTING_KEYS.defaultRole, value: settings.defaultRole },
    { key: SETTING_KEYS.healthModeratePct, value: String(settings.healthModeratePct) },
    { key: SETTING_KEYS.healthHeavyPct, value: String(settings.healthHeavyPct) },
    { key: SETTING_KEYS.retentionDays, value: String(settings.retentionDays) },
  ];
}
