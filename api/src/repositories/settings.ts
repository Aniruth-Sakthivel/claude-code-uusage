/**
 * Settings storage, plus the retention purge.
 */

import { eq, lt } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  appSettings,
  dailyAggregates,
  usageEvents,
  userPreferences,
  users,
} from "../db/schema.js";
import {
  parseSettings,
  toRows,
  type FleetSettings,
} from "../core/settings.js";

export async function getSettings(): Promise<FleetSettings> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings);
  return parseSettings(rows);
}

export async function saveSettings(
  settings: FleetSettings,
  actorUserId: number,
): Promise<FleetSettings> {
  const rows = toRows(settings);
  await db.transaction(async (tx) => {
    for (const row of rows) {
      await tx
        .insert(appSettings)
        .values({ ...row, updatedByUserId: actorUserId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: row.value, updatedByUserId: actorUserId, updatedAt: new Date() },
        });
    }
  });
  return getSettings();
}

// ── per-user ──────────────────────────────────────────────────────────────────

export interface NotificationPrefs {
  [key: string]: boolean;
}

export async function getPreferences(userId: number): Promise<NotificationPrefs> {
  const [row] = await db
    .select({ notifications: userPreferences.notifications })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.notifications);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {}; // hand-edited or corrupt — defaults are better than an error
  }
}

export async function savePreferences(
  userId: number,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  const encoded = JSON.stringify(prefs);
  await db
    .insert(userPreferences)
    .values({ userId, notifications: encoded, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: { notifications: encoded, updatedAt: new Date() },
    });
  return prefs;
}

export async function updateOwnProfile(
  userId: number,
  fullName: string,
  avatarUrl?: string | null,
): Promise<void> {
  const patch: Partial<typeof users.$inferInsert> = { fullName };
  // `undefined` means "not sent" (leave unchanged); `null` means "clear it".
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;
  await db.update(users).set(patch).where(eq(users.id, userId));
}

// ── retention ─────────────────────────────────────────────────────────────────

/**
 * Delete usage history older than `beforeDay` (a `YYYY-MM-DD` string).
 *
 * Nothing calls this on a schedule — the API has no scheduler. It runs when an
 * admin presses the button, or when an external cron hits the endpoint. The
 * settings page states this rather than implying automatic cleanup.
 */
export async function purgeUsageBefore(beforeDay: string): Promise<{
  events: number;
  aggregates: number;
}> {
  return db.transaction(async (tx) => {
    const events = await tx
      .delete(usageEvents)
      .where(lt(usageEvents.day, beforeDay))
      .returning({ id: usageEvents.eventId });
    const aggregates = await tx
      .delete(dailyAggregates)
      .where(lt(dailyAggregates.day, beforeDay))
      .returning({ day: dailyAggregates.day });
    return { events: events.length, aggregates: aggregates.length };
  });
}
