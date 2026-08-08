/**
 * Settings routes — fleet-wide (admin) and per-user (self).
 *
 * The split matters: `/settings` needs `manage_users` and changes behaviour
 * for everyone, while `/me/*` is always scoped to the caller's own row and
 * needs no capability at all.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { currentUser, requireCapability, requireUser } from "../core/guards.js";
import { ROLES } from "../core/rbac.js";
import { daysAgoUtc } from "../core/time.js";
import { cache } from "../core/cache.js";
import { CacheKeys, CacheTags } from "../core/cacheKeys.js";
import { writeAudit } from "../repositories/admin.js";
import * as repo from "../repositories/settings.js";
import { SETTING_DEFAULTS } from "../core/settings.js";

const settingsIn = z.object({
  registrationOpen: z.boolean(),
  defaultRole: z.enum(ROLES),
  healthModeratePct: z.number().int().min(1).max(99),
  healthHeavyPct: z.number().int().min(2).max(100),
  retentionDays: z.number().int().min(0).max(3650),
});

const profileIn = z.object({
  full_name: z.string().min(1).max(120),
  avatar_url: z.string().url().max(2048).nullish(),
});

// Preference keys are open-ended by design; values must be booleans so a
// nested object can't be smuggled into the stored JSON.
const preferencesIn = z.record(z.string().max(64), z.boolean());

export async function settingsRoutes(app: FastifyInstance) {
  // ── fleet settings ──────────────────────────────────────────────────────
  // Safe to cache: this is one global row (not per-user-scoped) that changes
  // only via the PATCH below, which invalidates it in the same request.
  app.get(
    "/api/v1/settings",
    { preHandler: requireCapability("manage_users") },
    async (_req, reply) => {
      const settings = await cache.remember(CacheKeys.fleetSettings(), () => repo.getSettings(), {
        ttlMs: 30_000,
        tags: [CacheTags.SETTINGS],
      });
      // private: this response is only ever served to a capability-gated
      // caller, never something a shared/browser cache should reuse.
      reply.header("Cache-Control", "private, max-age=30");
      return { settings, defaults: SETTING_DEFAULTS };
    },
  );

  app.patch(
    "/api/v1/settings",
    { preHandler: requireCapability("manage_users") },
    async (req) => {
      const user = currentUser(req);
      const body = settingsIn.parse(req.body ?? {});
      const saved = await repo.saveSettings(body, user.id);
      cache.invalidateTags([CacheTags.SETTINGS]);
      await writeAudit({
        actorUserId: user.id,
        actorEmail: user.email,
        action: "settings.updated",
        target: "fleet",
        detail: JSON.stringify(saved),
      });
      return { settings: saved };
    },
  );

  /**
   * Retention purge. Runs only when called — there is no scheduler in this
   * API, so an external cron (or an admin pressing the button) is what makes
   * retention actually happen.
   */
  app.post(
    "/api/v1/settings/purge",
    { preHandler: requireCapability("manage_users") },
    async (req) => {
      const user = currentUser(req);
      const { retentionDays } = await repo.getSettings();
      if (retentionDays <= 0) {
        return { purged: false, reason: "Retention is set to keep everything." };
      }
      const before = daysAgoUtc(retentionDays);
      const result = await repo.purgeUsageBefore(before);
      await writeAudit({
        actorUserId: user.id,
        actorEmail: user.email,
        action: "settings.purged",
        target: `before ${before}`,
        detail: `${result.events} events, ${result.aggregates} daily rows`,
      });
      return { purged: true, before, ...result };
    },
  );

  // ── own account ─────────────────────────────────────────────────────────
  app.patch("/api/v1/me/profile", { preHandler: requireUser }, async (req) => {
    const user = currentUser(req);
    const body = profileIn.parse(req.body ?? {});
    await repo.updateOwnProfile(user.id, body.full_name, body.avatar_url);
    return { full_name: body.full_name, avatar_url: body.avatar_url ?? null };
  });

  app.get("/api/v1/me/preferences", { preHandler: requireUser }, async (req) => ({
    notifications: await repo.getPreferences(currentUser(req).id),
  }));

  app.patch("/api/v1/me/preferences", { preHandler: requireUser }, async (req) => {
    const user = currentUser(req);
    const body = preferencesIn.parse(req.body ?? {});
    return { notifications: await repo.savePreferences(user.id, body) };
  });
}
