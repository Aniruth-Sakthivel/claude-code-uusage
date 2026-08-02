/**
 * Auth routes — provisioning and identity.
 *
 * Credentials live in Supabase; these endpoints only manage the local account
 * row that carries role and system scoping.
 */

import type { FastifyInstance } from "fastify";

import { bearerToken, verifySupabaseToken } from "../core/auth-user.js";
import { cache } from "../core/cache.js";
import { CacheKeys, CacheTags } from "../core/cacheKeys.js";
import { requestContext, requireUser, currentUser } from "../core/guards.js";
import * as authService from "../services/auth.js";
import * as adminRepo from "../repositories/admin.js";

export async function authRoutes(app: FastifyInstance) {
  // Public, global, and hit on every page load before login — a real,
  // frequent, cheap-to-cache read (2 DB queries: countUsers + getSettings).
  // Short TTL: a fresh install going from "no users" to "has an admin" (which
  // flips this value) should reflect within seconds, not linger stale.
  app.get("/api/v1/auth/registration-open", async (_req, reply) => {
    const open = await cache.remember(
      CacheKeys.registrationOpen(),
      () => authService.registrationOpen(),
      { ttlMs: 10_000, tags: [CacheTags.AUTH, CacheTags.SETTINGS] },
    );
    reply.header("Cache-Control", "public, max-age=10");
    return { open };
  });

  /**
   * Called by the frontend immediately after Supabase sign-in or sign-up.
   * Idempotent — safe to call on every login. Tighter limit than the global
   * default: this is the route that creates local accounts, so it's worth
   * throttling harder than ordinary reads.
   */
  app.post(
    "/api/v1/auth/provision",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const token = bearerToken(req.headers.authorization);
      const claims = await verifySupabaseToken(token);

      const principal = await authService.provisionUser({
        supabaseUserId: claims.sub,
        email: claims.email ?? "",
        fullName: claims.user_metadata?.full_name ?? "",
        ...requestContext(req),
      });

      const view = await adminRepo.getUserView(principal.id);
      return authService.userOut(view!);
    },
  );

  app.get("/api/v1/auth/me", { preHandler: requireUser }, async (req) => {
    const user = currentUser(req);
    const view = await adminRepo.getUserView(user.id);
    return authService.userOut(view!);
  });
}
