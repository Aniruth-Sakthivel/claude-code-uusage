/** Data access for epics — task groupings within an initiative. */

import { asc, eq } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { epics, type EpicRow } from "../db/schema.js";

export interface EpicCreateInput {
  name: string;
  description: string;
  color: string;
}

export async function createEpic(
  initiativeId: number,
  input: EpicCreateInput,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<EpicRow> {
  const rows = await conn
    .insert(epics)
    .values({ initiativeId, name: input.name, description: input.description, color: input.color, createdByUserId })
    .returning();
  return rows[0]!;
}

export async function listEpics(initiativeId: number, conn: DbLike = db): Promise<EpicRow[]> {
  return conn.select().from(epics).where(eq(epics.initiativeId, initiativeId)).orderBy(asc(epics.createdAt));
}

export async function getEpic(id: number, conn: DbLike = db): Promise<EpicRow | null> {
  const rows = await conn.select().from(epics).where(eq(epics.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface EpicUpdateInput {
  name?: string;
  description?: string;
  color?: string;
  status?: string;
}

export async function updateEpic(id: number, patch: EpicUpdateInput, conn: DbLike = db): Promise<EpicRow | null> {
  const rows = await conn.update(epics).set(patch).where(eq(epics.id, id)).returning();
  return rows[0] ?? null;
}

export async function deleteEpic(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(epics).where(eq(epics.id, id));
}
