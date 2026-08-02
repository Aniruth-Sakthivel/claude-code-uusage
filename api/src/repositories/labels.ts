/** Data access for workspace-wide labels and their task attachments. */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { labels, taskLabels, type LabelRow } from "../db/schema.js";

export async function listLabels(conn: DbLike = db): Promise<LabelRow[]> {
  return conn.select().from(labels).orderBy(asc(labels.name));
}

export async function createLabel(name: string, color: string, conn: DbLike = db): Promise<LabelRow> {
  const rows = await conn.insert(labels).values({ name, color }).returning();
  return rows[0]!;
}

export async function deleteLabel(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(labels).where(eq(labels.id, id));
}

export async function attachLabel(taskId: number, labelId: number, conn: DbLike = db): Promise<void> {
  await conn.insert(taskLabels).values({ taskId, labelId }).onConflictDoNothing();
}

export async function detachLabel(taskId: number, labelId: number, conn: DbLike = db): Promise<void> {
  await conn.delete(taskLabels).where(and(eq(taskLabels.taskId, taskId), eq(taskLabels.labelId, labelId)));
}

export async function listLabelsForTask(taskId: number, conn: DbLike = db): Promise<LabelRow[]> {
  const rows = await conn
    .select({ id: labels.id, name: labels.name, color: labels.color })
    .from(taskLabels)
    .innerJoin(labels, eq(labels.id, taskLabels.labelId))
    .where(eq(taskLabels.taskId, taskId));
  return rows;
}

/** Bulk variant for a task list (board view) — one query instead of N. */
export async function listLabelsForTasks(
  taskIds: number[],
  conn: DbLike = db,
): Promise<Map<number, LabelRow[]>> {
  if (taskIds.length === 0) return new Map();
  const rows = await conn
    .select({ taskId: taskLabels.taskId, id: labels.id, name: labels.name, color: labels.color })
    .from(taskLabels)
    .innerJoin(labels, eq(labels.id, taskLabels.labelId))
    .where(inArray(taskLabels.taskId, taskIds));
  const byTask = new Map<number, LabelRow[]>();
  for (const r of rows) {
    const list = byTask.get(r.taskId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    byTask.set(r.taskId, list);
  }
  return byTask;
}
