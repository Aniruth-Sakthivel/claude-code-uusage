/**
 * Agent-facing routes. Authenticated by API key only — never a user JWT.
 */

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { currentAgent, requireAgent } from "../core/guards.js";
import { badRequest } from "../core/errors.js";
import { db } from "../db/client.js";
import { systems } from "../db/schema.js";
import * as commandsRepo from "../repositories/commands.js";
import { ingestEvents, ingestSessionExtras, type IncomingEvent } from "../repositories/usage.js";
import * as healthService from "../services/health.js";
import {
  agentHealthReport,
  agentStatusRequest,
  commandAckRequest,
  registerRequest,
  syncRequest,
} from "../schemas/index.js";

/** Pending commands for this system, marked delivered so re-checking-in
 * doesn't re-count them as "just sent" — they stay pending (and so keep
 * being handed out) until the agent explicitly acks. */
async function pendingCommandsFor(systemId: string) {
  const rows = await commandsRepo.listUndelivered(systemId);
  if (rows.length > 0) {
    await commandsRepo.markDelivered(rows.map((r) => r.id));
  }
  return rows.map((r) => ({ id: r.id, action: r.action, payload: JSON.parse(r.payload || "{}") }));
}

export async function usageRoutes(app: FastifyInstance) {
  /** Confirm/refresh this machine's registration details. */
  app.post("/api/v1/systems/register", { preHandler: requireAgent }, async (req) => {
    const system = currentAgent(req);
    const body = registerRequest.parse(req.body ?? {});

    const patch: Record<string, unknown> = { lastSeenAt: new Date() };
    if (body.display_name) patch.displayName = body.display_name;
    if (body.hostname) patch.hostname = body.hostname;
    if (body.agent_version) patch.agentVersion = body.agent_version;

    await db.update(systems).set(patch).where(eq(systems.systemId, system.systemId));

    return {
      system_id: system.systemId,
      display_name: (patch.displayName as string) ?? system.displayName,
      commands: await pendingCommandsFor(system.systemId),
    };
  });

  app.post("/api/v1/systems/heartbeat", { preHandler: requireAgent }, async (req) => {
    const system = currentAgent(req);
    await db
      .update(systems)
      .set({ lastSeenAt: new Date() })
      .where(eq(systems.systemId, system.systemId));
    return { ok: true, commands: await pendingCommandsFor(system.systemId) };
  });

  /**
   * Agent reports what it is doing right now — "scanning", then "scanned",
   * then "syncing", then "idle".
   *
   * Separate from heartbeat because it fires several times per cycle and must
   * stay cheap: no command lookup, one UPDATE. It still refreshes `lastSeenAt`,
   * so a machine mid-scan never reads as silent.
   */
  app.post("/api/v1/systems/status", { preHandler: requireAgent }, async (req) => {
    const system = currentAgent(req);
    const body = agentStatusRequest.parse(req.body ?? {});
    const now = new Date();

    const patch: Record<string, unknown> = {
      lastSeenAt: now,
      agentStatus: body.state,
      agentStatusAt: now,
      agentStatusDetail: body.detail,
    };
    if (body.scan_interval_seconds != null) {
      patch.scanIntervalSeconds = body.scan_interval_seconds;
    }
    if (body.active_sessions != null) {
      patch.activeSessions = body.active_sessions;
    }
    if (body.last_scan_at) patch.lastScanAt = new Date(body.last_scan_at);
    if (body.last_scan_duration_ms != null) {
      patch.lastScanDurationMs = Math.round(body.last_scan_duration_ms);
    }

    await db.update(systems).set(patch).where(eq(systems.systemId, system.systemId));
    return { ok: true };
  });

  /**
   * Full local diagnostics snapshot, pushed rarely (every ~10th health-loop
   * tick, or on demand via the `health_check` command) — unlike `/status`
   * above, this does not need to stay cheap, but it also plays no part in
   * command delivery: an agent's commands always come from register/
   * heartbeat/sync/status, never from here.
   */
  app.post("/api/v1/systems/health", { preHandler: requireAgent }, async (req) => {
    const system = currentAgent(req);
    const body = agentHealthReport.parse(req.body ?? {});

    await db
      .update(systems)
      .set({ lastSeenAt: new Date() })
      .where(eq(systems.systemId, system.systemId));

    await healthService.reportHealth(system.systemId, {
      startedAt: body.started_at ? new Date(body.started_at) : null,
      updatedAt: body.updated_at ? new Date(body.updated_at) : null,
      lastScanAt: body.last_scan_at ? new Date(body.last_scan_at) : null,
      lastScanDurationMs:
        body.last_scan_duration_ms != null ? Math.round(body.last_scan_duration_ms) : null,
      lastScanError: body.last_scan_error ?? "",
      scansCompleted: body.scans_completed,
      scansFailed: body.scans_failed,
      wsConnected: body.ws_connected,
      wsLastConnectedAt: body.ws_last_connected_at ? new Date(body.ws_last_connected_at) : null,
      wsLastDisconnectReason: body.ws_last_disconnect_reason ?? "",
      wsReconnectAttempts: body.ws_reconnect_attempts,
      offlineQueueDepth: body.offline_queue_depth,
      activeSessions: body.active_sessions,
      pid: body.pid ?? null,
      validationIssues: JSON.stringify(body.validation_issues),
    });

    return { ok: true };
  });

  /** Agent reports the outcome of a delivered command. */
  app.post<{ Params: { id: string } }>(
    "/api/v1/systems/commands/:id/ack",
    { preHandler: requireAgent },
    async (req) => {
      const system = currentAgent(req);
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw badRequest("Invalid command id");
      const body = commandAckRequest.parse(req.body ?? {});
      const command = await commandsRepo.ackCommand(id, system.systemId, body.status, body.detail);
      if (!command) throw badRequest("Unknown command for this system");
      return { ok: true };
    },
  );

  /**
   * Batch usage upload. Idempotent by `event_id`, so retrying after a network
   * failure is always safe and never double-counts.
   */
  app.post("/api/v1/usage/sync", { preHandler: requireAgent }, async (req) => {
    const system = currentAgent(req);
    const body = syncRequest.parse(req.body ?? {});

    const events: IncomingEvent[] = body.events.map((e) => ({
      suffix: e.suffix,
      sessionId: e.session_id,
      projectName: e.project_name,
      tsUtc: e.ts_utc,
      day: e.day,
      model: e.model,
      modelFamily: e.model_family,
      inputTokens: e.input_tokens,
      outputTokens: e.output_tokens,
      cacheReadTokens: e.cache_read_tokens,
      cacheCreationTokens: e.cache_creation_tokens,
      totalTokens: e.total_tokens,
      toolName: e.tool_name ?? null,
      isSubagent: e.is_subagent,
      agentId: e.agent_id ?? null,
    }));

    // Prompt counts and titles are merged separately and never block the
    // event path — a failure here must not cost the machine its usage push.
    await ingestSessionExtras(
      system.systemId,
      body.prompts.map((p) => ({
        sessionId: p.session_id,
        day: p.day,
        promptCount: p.prompt_count,
      })),
      body.session_titles.map((t) => ({ sessionId: t.session_id, title: t.title })),
    );

    const result = await ingestEvents(system.systemId, events);
    return { ...result, commands: await pendingCommandsFor(system.systemId) };
  });
}
