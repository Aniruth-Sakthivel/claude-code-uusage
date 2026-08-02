/** Data access for sprints and the backlog (tasks with `sprintId IS NULL`). */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { sprints, tasks, type SprintRow } from "../db/schema.js";

export interface SprintCreateInput {
  name: string;
  startDate: string | null;
  endDate: string | null;
}

export async function createSprint(
  initiativeId: number,
  input: SprintCreateInput,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<SprintRow> {
  const rows = await conn
    .insert(sprints)
    .values({ initiativeId, name: input.name, startDate: input.startDate, endDate: input.endDate, createdByUserId })
    .returning();
  return rows[0]!;
}

export interface SprintWithCounts extends SprintRow {
  taskCount: number;
}

export async function listSprints(initiativeId: number, conn: DbLike = db): Promise<SprintWithCounts[]> {
  const rows = await conn
    .select()
    .from(sprints)
    .where(eq(sprints.initiativeId, initiativeId))
    .orderBy(desc(sprints.createdAt));
  if (rows.length === 0) return [];

  const counts = await conn
    .select({ sprintId: tasks.sprintId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(sql`${tasks.sprintId} = any(${rows.map((r) => r.id)})`)
    .groupBy(tasks.sprintId);
  const byId = new Map(counts.map((c) => [c.sprintId, c.n]));

  return rows.map((r) => ({ ...r, taskCount: byId.get(r.id) ?? 0 }));
}

export async function getSprint(id: number, conn: DbLike = db): Promise<SprintRow | null> {
  const rows = await conn.select().from(sprints).where(eq(sprints.id, id)).limit(1);
  return rows[0] ?? null;
}

export interface SprintUpdateInput {
  name?: string;
  startDate?: string | null;
  endDate?: string | null;
  status?: string;
}

export async function updateSprint(
  id: number,
  patch: SprintUpdateInput,
  conn: DbLike = db,
): Promise<SprintRow | null> {
  const rows = await conn.update(sprints).set(patch).where(eq(sprints.id, id)).returning();
  return rows[0] ?? null;
}

export async function deleteSprint(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(sprints).where(eq(sprints.id, id));
}

/** Backlog: this initiative's tasks not on any sprint. */
export async function listBacklog(initiativeId: number, conn: DbLike = db) {
  return conn
    .select()
    .from(tasks)
    .where(and(eq(tasks.initiativeId, initiativeId), isNull(tasks.sprintId)))
    .orderBy(asc(tasks.createdAt));
}

export async function listSprintTasks(sprintId: number, conn: DbLike = db) {
  return conn.select().from(tasks).where(eq(tasks.sprintId, sprintId)).orderBy(asc(tasks.createdAt));
}

export async function assignTaskToSprint(
  taskId: number,
  sprintId: number | null,
  conn: DbLike = db,
): Promise<void> {
  await conn.update(tasks).set({ sprintId }).where(eq(tasks.id, taskId));
}
