/**
 * Administrative routes, each gated by a specific capability.
 */

import type { FastifyInstance } from "fastify";

import { currentUser, requestContext, requireCapability } from "../core/guards.js";
import { ROLES, ROLE_DESCRIPTIONS } from "../core/rbac.js";
import type { ApiKeyRow, SystemRow } from "../db/schema.js";
import * as repo from "../repositories/admin.js";
import { isOnline } from "../core/time.js";
import {
  apiKeyCreate,
  systemCreate,
  userCreate,
  userUpdate,
} from "../schemas/index.js";
import * as admin from "../services/admin.js";
import { userOut } from "../services/auth.js";

function keyOut(k: ApiKeyRow) {
  return {
    id: k.id,
    system_id: k.systemId,
    name: k.name,
    prefix: k.prefix,
    created_at: k.createdAt.toISOString(),
    last_used_at: k.lastUsedAt?.toISOString() ?? null,
    revoked_at: k.revokedAt?.toISOString() ?? null,
    active: k.revokedAt === null,
  };
}

function systemOut(s: SystemRow) {
  return {
    system_id: s.systemId,
    display_name: s.displayName,
    hostname: s.hostname,
    agent_version: s.agentVersion,
    owner: s.owner,
    location: s.location,
    environment: s.environment,
    notes: s.notes,
    last_seen_at: s.lastSeenAt?.toISOString() ?? null,
    last_sync_at: s.lastSyncAt?.toISOString() ?? null,
    created_at: s.createdAt.toISOString(),
    status: isOnline(s.lastSeenAt) ? ("online" as const) : ("offline" as const),
    total_tokens: 0,
    sessions: 0,
    projects: 0,
    never_synced: s.lastSyncAt === null,
  };
}

export async function adminRoutes(app: FastifyInstance) {
  const manageUsers = { preHandler: requireCapability("manage_users") };
  const manageKeys = { preHandler: requireCapability("manage_keys") };
  const manageSystems = { preHandler: requireCapability("manage_systems") };
  const viewAudit = { preHandler: requireCapability("view_audit") };

  // ── roles & users ───────────────────────────────────────────────────────────
  app.get("/api/v1/admin/roles", manageUsers, async () =>
    ROLES.map((name) => ({ name, description: ROLE_DESCRIPTIONS[name] })),
  );

  app.get("/api/v1/admin/users", manageUsers, async () => {
    const views = await repo.listUsers();
    return views.map(userOut);
  });

  app.post("/api/v1/admin/users", manageUsers, async (req, reply) => {
    const body = userCreate.parse(req.body ?? {});
    const origin = req.headers.origin as string | undefined;

    const { view, invited } = await admin.createUser(
      currentUser(req),
      body,
      requestContext(req),
      origin ? `${origin}/login` : undefined,
    );
    return reply.code(201).send({ ...userOut(view), invited });
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id",
    manageUsers,
    async (req) => {
      const body = userUpdate.parse(req.body ?? {});
      const view = await admin.updateUser(
        currentUser(req),
        Number(req.params.id),
        body,
        requestContext(req),
      );
      return userOut(view);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id",
    manageUsers,
    async (req, reply) => {
      await admin.deleteUser(currentUser(req), Number(req.params.id), requestContext(req));
      return reply.code(204).send();
    },
  );

  // ── systems & keys ──────────────────────────────────────────────────────────
  app.post("/api/v1/admin/systems", manageSystems, async (req, reply) => {
    const body = systemCreate.parse(req.body ?? {});
    const { system, apiKey } = await admin.createSystem(
      currentUser(req),
      body,
      requestContext(req),
    );
    return reply.code(201).send({ system: systemOut(system), api_key: apiKey });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/systems/:id",
    manageSystems,
    async (req, reply) => {
      await admin.deleteSystem(currentUser(req), req.params.id, requestContext(req));
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/systems/:id/keys",
    manageKeys,
    async (req) => (await repo.listApiKeys(req.params.id)).map(keyOut),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/systems/:id/keys",
    manageKeys,
    async (req, reply) => {
      const body = apiKeyCreate.parse(req.body ?? {});
      const { keyRow, apiKey } = await admin.issueApiKey(
        currentUser(req),
        req.params.id,
        body.name,
        requestContext(req),
      );
      return reply.code(201).send({ key: keyOut(keyRow), api_key: apiKey });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/keys/:id/rotate",
    manageKeys,
    async (req) => {
      const { keyRow, apiKey } = await admin.rotateApiKey(
        currentUser(req),
        Number(req.params.id),
        requestContext(req),
      );
      return { key: keyOut(keyRow), api_key: apiKey };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/keys/:id",
    manageKeys,
    async (req, reply) => {
      await admin.revokeApiKey(currentUser(req), Number(req.params.id), requestContext(req));
      return reply.code(204).send();
    },
  );

  // ── audit ───────────────────────────────────────────────────────────────────
  app.get("/api/v1/admin/audit", viewAudit, async () => {
    const rows = await repo.listAudit();
    return rows.map((a) => ({
      id: a.id,
      actor_email: a.actorEmail,
      action: a.action,
      target: a.target,
      detail: a.detail,
      at: a.at.toISOString(),
    }));
  });
}
