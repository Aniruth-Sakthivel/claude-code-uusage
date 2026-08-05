/**
 * Data access for fleet-management commands (`agent_commands`).
 *
 * A command is queued by an operator and picked up by the target agent on
 * its next check-in — REST (register/heartbeat/sync) or WS (heartbeat/
 * scan_result), whichever the agent uses. See db/schema.ts for why this is a
 * durable table rather than a fire-and-forget WS push.
 */

import { and, desc, eq, inArray } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { agentCommands, type AgentCommandRow } from "../db/schema.js";

export async function createCommand(
  systemId: string,
  action: string,
  payload: Record<string, unknown>,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<AgentCommandRow> {
  const rows = await conn
    .insert(agentCommands)
    .values({
      systemId,
      action,
      payload: JSON.stringify(payload),
      createdByUserId,
    })
    .returning();
  return rows[0]!;
}

/** Commands not yet acked by the agent — handed out on every check-in until
 * they are, so a delivery that never got acked (e.g. daemon restarted mid-
 * command) is simply retried next time. */
export async function listUndelivered(
  systemId: string,
  conn: DbLike = db,
): Promise<AgentCommandRow[]> {
  return conn
    .select()
    .from(agentCommands)
    .where(and(eq(agentCommands.systemId, systemId), eq(agentCommands.status, "pending")))
    .orderBy(agentCommands.createdAt);
}

export async function markDelivered(ids: number[], conn: DbLike = db): Promise<void> {
  if (ids.length === 0) return;
  await conn
    .update(agentCommands)
    .set({ deliveredAt: new Date() })
    .where(inArray(agentCommands.id, ids));
}

export async function ackCommand(
  id: number,
  systemId: string,
  status: "acked" | "failed" | "skipped",
  detail: string,
  conn: DbLike = db,
): Promise<AgentCommandRow | null> {
  const rows = await conn
    .update(agentCommands)
    .set({ status, ackedAt: new Date(), ackDetail: detail })
    .where(and(eq(agentCommands.id, id), eq(agentCommands.systemId, systemId)))
    .returning();
  return rows[0] ?? null;
}

export async function listForSystem(
  systemId: string,
  limit = 100,
  conn: DbLike = db,
): Promise<AgentCommandRow[]> {
  return conn
    .select()
    .from(agentCommands)
    .where(eq(agentCommands.systemId, systemId))
    .orderBy(desc(agentCommands.createdAt))
    .limit(limit);
}
