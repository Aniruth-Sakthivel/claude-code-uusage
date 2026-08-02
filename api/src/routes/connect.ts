/**
 * One-click PC connect.
 *
 * `POST /connect/self` is available to EVERY signed-in role. That is deliberate:
 * previously only admins could create a system, so a developer or viewer signed
 * in, saw an empty dashboard, and had no way forward.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { currentUser, requestContext, requireUser } from "../core/guards.js";
import { visibleSystemIds } from "../core/rbac.js";
import { connectRequest } from "../schemas/index.js";
import * as onboarding from "../services/onboarding.js";

/** Public origin of this request, for building absolute install URLs. */
function originOf(req: FastifyRequest): string {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host;
  return host ? `${proto}://${host}` : "";
}

export async function connectRoutes(app: FastifyInstance) {
  app.post(
    "/api/v1/connect/self",
    {
      preHandler: requireUser,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (req) => {
      const user = currentUser(req);
      const body = connectRequest.parse(req.body ?? {});

      const result = await onboarding.connectPc(
        user,
        visibleSystemIds(user),
        body,
        originOf(req),
        requestContext(req),
      );

      // Opportunistic cleanup of expired tokens; never fails the request.
      void onboarding.sweepEnrollTokens().catch(() => {});

      return {
        system_id: result.systemId,
        display_name: result.displayName,
        install_command: result.installCommand,
        manual_commands: result.manualCommands,
        api_key: result.apiKey,
        expires_at: result.expiresAt.toISOString(),
      };
    },
  );

  /**
   * Serves the generated PowerShell installer.
   *
   * Unauthenticated by design — the single-use, 15-minute token IS the
   * credential, because `irm | iex` cannot send an Authorization header.
   * Rate-limited tighter than the global default: this is the one
   * unauthenticated route in the app, so it's the one worth throttling
   * hardest against token-guessing/scanning even though 256-bit token
   * entropy already makes that impractical on its own.
   */
  app.get<{ Params: { token: string } }>(
    "/api/v1/connect/script/:token",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const script = await onboarding.redeemEnrollToken(req.params.token, originOf(req));
      return reply
        .type("text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .send(script);
    },
  );
}
