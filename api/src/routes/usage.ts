/**
 * Agent-facing routes. Authenticated by API key only — never a user JWT.
 */

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { currentAgent, requireAgent } from "../core/guards.js";
import { db } from "../db/client.js";
import { systems } from "../db/schema.js";
import { ingestEvents, ingestSessionExtras, type IncomingEvent } from "../repositories/usage.js";
import { registerRequest, syncRequest } from "../schemas/index.js";

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
    };
  });

  app.post("/api/v1/systems/heartbeat", { preHandler: requireAgent }, async (req) => {
    const system = currentAgent(req);
    await db
      .update(systems)
      .set({ lastSeenAt: new Date() })
      .where(eq(systems.systemId, system.systemId));
    return { ok: true };
  });

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

    return ingestEvents(system.systemId, events);
  });
}
