/**
 * Auth routes — provisioning and identity.
 *
 * Credentials live in Supabase; these endpoints only manage the local account
 * row that carries role and system scoping.
 */

import type { FastifyInstance } from "fastify";

import { bearerToken, verifySupabaseToken } from "../core/auth-user.js";
import { requestContext, requireUser, currentUser } from "../core/guards.js";
import * as authService from "../services/auth.js";
import * as adminRepo from "../repositories/admin.js";

export async function authRoutes(app: FastifyInstance) {
  app.get("/api/v1/auth/registration-open", async () => ({
    open: await authService.registrationOpen(),
  }));

  /**
   * Called by the frontend immediately after Supabase sign-in or sign-up.
   * Idempotent — safe to call on every login.
   */
  app.post("/api/v1/auth/provision", async (req) => {
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
  });

  app.get("/api/v1/auth/me", { preHandler: requireUser }, async (req) => {
    const user = currentUser(req);
    const view = await adminRepo.getUserView(user.id);
    return authService.userOut(view!);
  });
}
