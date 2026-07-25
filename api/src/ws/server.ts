/**
 * Real-time WebSocket server — a separate persistent process from the Netlify
 * API (see db.ts for why). Two client kinds, distinguished by path:
 *
 *   wss://host:PORT/agent?      -- agents (Authorization: Bearer cfk_... header,
 *                                   same key/verification as REST agent routes)
 *   wss://host:PORT/dashboard   -- browsers (?token=<supabase JWT> query param,
 *                                   since native WebSocket cannot set custom
 *                                   headers on the handshake)
 *
 * Security posture:
 *   - Auth happens before any message is processed; unauthenticated sockets
 *     are closed immediately (custom code 4401), never added to the client map.
 *   - Every inbound frame is size-capped (ws `maxPayload`), rate-limited
 *     (TokenBucket per connection), and schema-validated (protocol.ts) before
 *     it can reach a handler — the same discipline the REST layer applies to
 *     request bodies.
 *   - Dashboard broadcasts are filtered through the same `visibleSystemIds`
 *     scoping the REST API enforces, so a developer's socket never receives
 *     updates for a system they cannot see via the API either.
 *   - Heartbeat (protocol-level ping + liveness sweep) reaps dead connections
 *     so a network-dropped client doesn't leak a slot forever.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { eq } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";

import { config } from "../config.js";
import { authenticateAgent } from "../core/auth-agent.js";
import { loadPrincipal, verifySupabaseToken } from "../core/auth-user.js";
import { visibleSystemIds } from "../core/rbac.js";
import { systems } from "../db/schema.js";
import { ingestEvents } from "../repositories/usage.js";
import { closeWsDb, wsDb } from "./db.js";
import {
  agentMessageIn,
  dashboardMessageIn,
  MAX_INBOUND_MESSAGE_BYTES,
  type AlertOut,
  type SystemUpdatedOut,
} from "./protocol.js";
import { TokenBucket } from "./rateLimit.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
// ~1 message/sec sustained, bursts up to 20 — generous for heartbeat + one
// scan_result per minute, tight enough that a runaway loop can't flood us.
const RATE_LIMIT_CAPACITY = 20;
const RATE_LIMIT_PER_SECOND = 1;

type ConnMeta =
  | { role: "agent"; systemId: string; connectionId: string }
  | { role: "dashboard"; userId: number; visibleSystemIds: string[] | null; connectionId: string };

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

class RealtimeHub {
  private readonly clients = new Map<WebSocket, ConnMeta>();
  private readonly buckets = new Map<WebSocket, TokenBucket>();

  register(ws: WebSocket, meta: ConnMeta): void {
    this.clients.set(ws, meta);
    this.buckets.set(ws, new TokenBucket(RATE_LIMIT_CAPACITY, RATE_LIMIT_PER_SECOND));
  }

  unregister(ws: WebSocket): void {
    this.clients.delete(ws);
    this.buckets.delete(ws);
  }

  meta(ws: WebSocket): ConnMeta | undefined {
    return this.clients.get(ws);
  }

  /** Consumes one rate-limit token; false means the caller should drop the frame. */
  allow(ws: WebSocket): boolean {
    return this.buckets.get(ws)?.tryConsume() ?? false;
  }

  broadcastToDashboards(systemId: string, payload: SystemUpdatedOut | AlertOut): void {
    const body = JSON.stringify(payload);
    for (const [ws, meta] of this.clients) {
      if (meta.role !== "dashboard") continue;
      if (meta.visibleSystemIds !== null && !meta.visibleSystemIds.includes(systemId)) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(body);
    }
  }

  /** Extension point: e.g. an admin action that asks a specific PC to scan now. */
  sendCommandToAgent(systemId: string, action: "scan_now"): boolean {
    for (const [ws, meta] of this.clients) {
      if (meta.role === "agent" && meta.systemId === systemId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "command", action }));
        return true;
      }
    }
    return false;
  }

  closeAll(code: number, reason: string): void {
    for (const ws of this.clients.keys()) {
      try {
        ws.close(code, reason);
      } catch {
        // best-effort during shutdown
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}

const hub = new RealtimeHub();

async function authenticateConnection(req: IncomingMessage): Promise<ConnMeta | null> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/agent")) {
    try {
      const system = await authenticateAgent(req.headers.authorization, wsDb);
      return { role: "agent", systemId: system.systemId, connectionId: randomUUID() };
    } catch {
      return null;
    }
  }

  if (url.pathname.startsWith("/dashboard")) {
    const token = url.searchParams.get("token");
    if (!token) return null;
    try {
      const claims = await verifySupabaseToken(token);
      const principal = await loadPrincipal(claims.sub);
      return {
        role: "dashboard",
        userId: principal.id,
        visibleSystemIds: visibleSystemIds(principal),
        connectionId: randomUUID(),
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function touchLastSeen(systemId: string): Promise<void> {
  await wsDb.update(systems).set({ lastSeenAt: new Date() }).where(eq(systems.systemId, systemId));
}

async function handleAgentMessage(ws: WebSocket, meta: Extract<ConnMeta, { role: "agent" }>, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("ws.malformed_json", { connectionId: meta.connectionId });
    return;
  }

  const result = agentMessageIn.safeParse(parsed);
  if (!result.success) {
    log("ws.invalid_message", { connectionId: meta.connectionId, issues: result.error.issues });
    ws.send(JSON.stringify({ type: "error", message: "invalid message" }));
    return;
  }

  const message = result.data;
  const now = new Date().toISOString();

  switch (message.type) {
    case "heartbeat": {
      await touchLastSeen(meta.systemId);
      break;
    }
    case "scan_result": {
      await touchLastSeen(meta.systemId);
      log("ws.scan_result", {
        systemId: meta.systemId,
        trigger: message.trigger,
        durationMs: message.duration_ms,
        eventsInserted: message.events_inserted,
      });
      const update: SystemUpdatedOut = {
        type: "system_updated",
        system_id: meta.systemId,
        reason: "scan_result",
        at: now,
      };
      hub.broadcastToDashboards(meta.systemId, update);
      break;
    }
    case "alert": {
      log("ws.alert", { systemId: meta.systemId, level: message.level, message: message.message });
      const alert: AlertOut = {
        type: "alert",
        system_id: meta.systemId,
        level: message.level,
        message: message.message,
        at: now,
      };
      hub.broadcastToDashboards(meta.systemId, alert);
      break;
    }
    case "sync": {
      const result = await ingestEvents(meta.systemId, message.events.map((e) => ({
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
      })), wsDb);
      ws.send(JSON.stringify({ type: "ack", ...result }));
      hub.broadcastToDashboards(meta.systemId, {
        type: "system_updated",
        system_id: meta.systemId,
        reason: "scan_result",
        at: now,
      });
      break;
    }
  }
}

function handleDashboardMessage(ws: WebSocket, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const result = dashboardMessageIn.safeParse(parsed);
  if (!result.success) return;
  if (result.data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
}

export function startWsServer(port = config.WS_PORT): WebSocketServer {
  const wss = new WebSocketServer({
    port,
    maxPayload: MAX_INBOUND_MESSAGE_BYTES + 4096,
  });

  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    const meta = await authenticateConnection(req);
    if (!meta) {
      ws.close(4401, "unauthorized");
      return;
    }

    hub.register(ws, meta);
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    log("ws.connected", { role: meta.role, connectionId: meta.connectionId });

    ws.on("pong", () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    ws.on("message", async (data) => {
      if (!hub.allow(ws)) {
        ws.send(JSON.stringify({ type: "error", message: "rate limit exceeded" }));
        return;
      }
      const raw = data.toString();
      try {
        if (meta.role === "agent") {
          await handleAgentMessage(ws, meta, raw);
        } else {
          handleDashboardMessage(ws, raw);
        }
      } catch (err) {
        log("ws.handler_error", {
          connectionId: meta.connectionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    ws.on("close", () => {
      hub.unregister(ws);
      log("ws.disconnected", { role: meta.role, connectionId: meta.connectionId });
    });

    ws.on("error", (err) => {
      log("ws.socket_error", { connectionId: meta.connectionId, error: err.message });
    });
  });

  // Liveness sweep: ping everyone; anyone who didn't pong since the last sweep
  // gets terminated. Standard `ws` heartbeat pattern.
  const sweep = setInterval(() => {
    for (const ws of wss.clients) {
      const tracked = ws as WebSocket & { isAlive?: boolean };
      if (tracked.isAlive === false) {
        ws.terminate();
        continue;
      }
      tracked.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  sweep.unref();
  void HEARTBEAT_TIMEOUT_MS; // documents intent: sweep interval < timeout margin

  wss.on("listening", () => log("ws.listening", { port }));

  const shutdown = async (signal: string) => {
    log("ws.shutting_down", { signal, clients: hub.size });
    clearInterval(sweep);
    hub.closeAll(1001, "server shutting down");
    wss.close();
    await closeWsDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return wss;
}

// Allow running directly: `tsx src/ws/server.ts` / `node dist/ws/server.js`.
if (import.meta.url === `file://${process.argv[1]}`) {
  startWsServer();
}
