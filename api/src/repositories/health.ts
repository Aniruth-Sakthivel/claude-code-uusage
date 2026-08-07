/**
 * Data access for the agent's full diagnostics snapshot (`agent_health_snapshots`).
 *
 * One row per system, upserted in place — see db/schema.ts for why this is not
 * a history table.
 */

import { eq } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { agentHealthSnapshots, type AgentHealthSnapshotRow } from "../db/schema.js";

export interface HealthSnapshotInput {
  startedAt: Date | null;
  updatedAt: Date | null;
  lastScanAt: Date | null;
  lastScanDurationMs: number | null;
  lastScanError: string;
  scansCompleted: number;
  scansFailed: number;
  wsConnected: boolean;
  wsLastConnectedAt: Date | null;
  wsLastDisconnectReason: string;
  wsReconnectAttempts: number;
  offlineQueueDepth: number;
  activeSessions: number;
  pid: number | null;
  validationIssues: string; // JSON-encoded array
}

export async function upsertHealthSnapshot(
  systemId: string,
  data: HealthSnapshotInput,
  conn: DbLike = db,
): Promise<void> {
  await conn
    .insert(agentHealthSnapshots)
    .values({ systemId, ...data, recordedAt: new Date() })
    .onConflictDoUpdate({
      target: agentHealthSnapshots.systemId,
      set: { ...data, recordedAt: new Date() },
    });
}

export async function getHealthSnapshot(
  systemId: string,
  conn: DbLike = db,
): Promise<AgentHealthSnapshotRow | null> {
  const rows = await conn
    .select()
    .from(agentHealthSnapshots)
    .where(eq(agentHealthSnapshots.systemId, systemId))
    .limit(1);
  return rows[0] ?? null;
}
