/**
 * WebSocket message contract.
 *
 * Every inbound frame is parsed through one of these schemas before it
 * touches any handler — an agent (or anyone who obtains a valid-looking
 * frame) cannot inject arbitrary shape into the ingest path. This mirrors how
 * REST bodies are validated in schemas/index.ts; the WS transport gets the
 * same discipline.
 */

import { z } from "zod";

import { usageEventIn, MAX_SYNC_BATCH } from "../schemas/index.js";

// ── inbound: agent -> server ────────────────────────────────────────────────
export const agentHeartbeatIn = z.object({ type: z.literal("heartbeat") });

export const agentScanResultIn = z.object({
  type: z.literal("scan_result"),
  trigger: z.string().max(32).default("schedule"),
  duration_ms: z.number().finite().min(0).max(3_600_000),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  new: z.number().int().min(0),
  updated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  events_inserted: z.number().int().min(0),
  max_rss_kb: z.number().nullable().optional(),
  user_cpu_seconds: z.number().nullable().optional(),
});

export const agentAlertIn = z.object({
  type: z.literal("alert"),
  level: z.enum(["info", "warning", "error"]),
  message: z.string().max(2000),
});

/**
 * Bulk usage events, same shape/cap as the REST `/usage/sync` body — this is
 * an optional path for agents that prefer pushing over the open socket
 * instead of a separate HTTP call; not currently used by the reference agent
 * (which still POSTs to /usage/sync for the well-tested batched/idempotent
 * write path), but validated identically so either transport is safe to add.
 */
export const agentSyncIn = z.object({
  type: z.literal("sync"),
  events: z.array(usageEventIn).max(MAX_SYNC_BATCH),
});

export const agentMessageIn = z.discriminatedUnion("type", [
  agentHeartbeatIn,
  agentScanResultIn,
  agentAlertIn,
  agentSyncIn,
]);
export type AgentMessageIn = z.infer<typeof agentMessageIn>;

// ── inbound: dashboard -> server ────────────────────────────────────────────
const dashboardPingIn = z.object({ type: z.literal("ping") });

/** Real-time chat send. REST (`POST /chat/channels/:id/messages`) covers
 * clients without an open socket; this is the low-latency path for ones
 * that do — see ws/server.ts. */
const chatSendIn = z.object({
  type: z.literal("chat_send"),
  channel_id: z.number().int(),
  body: z.string().min(1).max(10_000),
});

/**
 * Whiteboard edits — a board has no meaningful "offline send" the way chat
 * does (see routes/whiteboard.ts), so this is the *only* write path, not a
 * low-latency companion to a REST one.
 */
const boardOpIn = z.object({
  type: z.literal("board_op"),
  board_id: z.number().int(),
  op: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("create"), element_kind: z.enum(["note", "stroke"]), data: z.record(z.string(), z.unknown()) }),
    z.object({ kind: z.literal("update"), element_id: z.number().int(), data: z.record(z.string(), z.unknown()) }),
    z.object({ kind: z.literal("delete"), element_id: z.number().int() }),
  ]),
});

export const dashboardMessageIn = z.discriminatedUnion("type", [dashboardPingIn, chatSendIn, boardOpIn]);
export type DashboardMessageIn = z.infer<typeof dashboardMessageIn>;

// ── outbound: server -> agent ───────────────────────────────────────────────
/**
 * `id` lets the agent ack a specific command back over REST
 * (`POST /systems/commands/:id/ack`) even though it arrived over WS — the two
 * transports share one durable queue, see db/schema.ts `agentCommands`.
 */
export interface CommandOut {
  type: "command";
  id: number;
  action: "scan_now" | "pause" | "resume" | "set_config";
  payload: Record<string, unknown>;
}

// ── outbound: server -> dashboard ───────────────────────────────────────────
export interface SystemUpdatedOut {
  type: "system_updated";
  system_id: string;
  /**
   * "connected" is reserved for a future direct HTTP->WS bridge — connectPc()
   * runs in the Netlify Functions process, a different process from this WS
   * server, so it cannot broadcast this reason today. Clients currently infer
   * "new system" by first-sighting a system_id, not by this reason value.
   */
  reason: "scan_result" | "heartbeat" | "alert" | "connected";
  at: string;
}

export interface ChatMessageOut {
  type: "chat_message";
  channel_id: number;
  message: {
    id: number;
    author_user_id: number | null;
    author_email: string;
    body: string;
    created_at: string;
  };
}

export interface BoardUpdateOut {
  type: "board_update";
  board_id: number;
  element: {
    id: number;
    kind: "note" | "stroke";
    data: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  };
}

export interface BoardDeleteOut {
  type: "board_delete";
  board_id: number;
  element_id: number;
}

export interface AlertOut {
  type: "alert";
  system_id: string;
  level: "info" | "warning" | "error";
  message: string;
  at: string;
}

/**
 * Structured error frame — never crashes the socket, just tells the client
 * what went wrong. `type` (not `event`) stays the discriminator key: the
 * reference Python agent (agent/meterhouse/ws_client.py) already branches on
 * `message["type"]`, so changing that key would be a breaking wire-protocol
 * change across repos, not just this one.
 */
export interface WsErrorOut {
  type: "error";
  code: WsErrorCode;
  message: string;
}

export const WsErrorCode = {
  INVALID_MESSAGE: "INVALID_MESSAGE",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type WsErrorCode = (typeof WsErrorCode)[keyof typeof WsErrorCode];

export function wsError(code: WsErrorCode, message: string): WsErrorOut {
  return { type: "error", code, message };
}

export const MAX_INBOUND_MESSAGE_BYTES = 512_000;
