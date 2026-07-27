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
export const dashboardMessageIn = z.object({ type: z.literal("ping") });
export type DashboardMessageIn = z.infer<typeof dashboardMessageIn>;

// ── outbound: server -> agent ───────────────────────────────────────────────
export interface CommandOut {
  type: "command";
  action: "scan_now";
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

export interface AlertOut {
  type: "alert";
  system_id: string;
  level: "info" | "warning" | "error";
  message: string;
  at: string;
}

export const MAX_INBOUND_MESSAGE_BYTES = 512_000;
