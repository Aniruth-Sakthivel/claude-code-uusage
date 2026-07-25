/**
 * Fastify auth guards.
 *
 * Two distinct preHandlers that never overlap:
 *   - `requireUser` / `requireCapability` — humans, via Supabase JWT.
 *   - `requireAgent`                     — PCs, via `cfk_` API key.
 *
 * An agent key presented to a user route fails JWT verification; a user JWT
 * presented to an agent route fails the key-hash lookup. Neither can stand in
 * for the other, which is asserted by tests.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { authenticateAgent } from "./auth-agent.js";
import { bearerToken, loadPrincipal, verifySupabaseToken } from "./auth-user.js";
import { forbidden } from "./errors.js";
import { can, type Capability, type Principal } from "./rbac.js";
import type { SystemRow } from "../db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: Principal;
    agentSystem?: SystemRow;
  }
}

/** Request context recorded on audit entries. */
export function requestContext(req: FastifyRequest) {
  return {
    ip: req.ip,
    userAgent: String(req.headers["user-agent"] ?? ""),
  };
}

export async function requireUser(req: FastifyRequest, _reply: FastifyReply) {
  const token = bearerToken(req.headers.authorization);
  const claims = await verifySupabaseToken(token);
  req.user = await loadPrincipal(claims.sub);
}

export function requireCapability(capability: Capability) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    await requireUser(req, reply);
    if (!req.user || !can(req.user, capability)) {
      throw forbidden(`Requires capability: ${capability}`);
    }
  };
}

export async function requireAgent(req: FastifyRequest, _reply: FastifyReply) {
  req.agentSystem = await authenticateAgent(req.headers.authorization);
}

/** Narrowing helpers — the guards guarantee these are set. */
export function currentUser(req: FastifyRequest): Principal {
  if (!req.user) throw forbidden("Not authenticated");
  return req.user;
}

export function currentAgent(req: FastifyRequest): SystemRow {
  if (!req.agentSystem) throw forbidden("Not authenticated");
  return req.agentSystem;
}
