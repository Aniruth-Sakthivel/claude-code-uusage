/**
 * Per-initiative board columns (custom workflow). Every initiative gets the
 * three defaults seeded at creation; from there, columns can be added,
 * renamed, reordered, or removed. See db/schema.ts `boardColumns`.
 */

import { asc, eq, sql } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { boardColumns, tasks, type BoardColumnRow } from "../db/schema.js";

export const DEFAULT_COLUMNS = [
  { key: "todo", label: "Todo", isDoneColumn: false },
  { key: "in_progress", label: "In progress", isDoneColumn: false },
  { key: "done", label: "Done", isDoneColumn: true },
];

export async function seedDefaultColumns(initiativeId: number, conn: DbLike = db): Promise<void> {
  await conn.insert(boardColumns).values(
    DEFAULT_COLUMNS.map((c, i) => ({ initiativeId, key: c.key, label: c.label, position: i, isDoneColumn: c.isDoneColumn })),
  );
}

export async function listColumns(initiativeId: number, conn: DbLike = db): Promise<BoardColumnRow[]> {
  return conn
    .select()
    .from(boardColumns)
    .where(eq(boardColumns.initiativeId, initiativeId))
    .orderBy(asc(boardColumns.position));
}

/** Idempotent: an initiative created before this feature shipped has zero
 * rows here, so callers that need columns to exist should call this first
 * rather than assuming `seedDefaultColumns` already ran. */
export async function ensureColumns(initiativeId: number, conn: DbLike = db): Promise<BoardColumnRow[]> {
  const existing = await listColumns(initiativeId, conn);
  if (existing.length > 0) return existing;
  await seedDefaultColumns(initiativeId, conn);
  return listColumns(initiativeId, conn);
}

export async function getColumn(id: number, conn: DbLike = db): Promise<BoardColumnRow | null> {
  const rows = await conn.select().from(boardColumns).where(eq(boardColumns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function columnKeyExists(initiativeId: number, key: string, conn: DbLike = db): Promise<boolean> {
  const rows = await conn
    .select({ id: boardColumns.id })
    .from(boardColumns)
    .where(sql`${boardColumns.initiativeId} = ${initiativeId} and ${boardColumns.key} = ${key}`)
    .limit(1);
  return rows.length > 0;
}

export async function createColumn(
  initiativeId: number,
  key: string,
  label: string,
  conn: DbLike = db,
): Promise<BoardColumnRow> {
  const rows = await conn
    .select({ m: sql<number | null>`max(${boardColumns.position})` })
    .from(boardColumns)
    .where(eq(boardColumns.initiativeId, initiativeId));
  const position = (rows[0]?.m ?? -1) + 1;
  const created = await conn
    .insert(boardColumns)
    .values({ initiativeId, key, label, position })
    .returning();
  return created[0]!;
}

export interface ColumnUpdateInput {
  label?: string;
  position?: number;
  isDoneColumn?: boolean;
}

export async function updateColumn(
  id: number,
  patch: ColumnUpdateInput,
  conn: DbLike = db,
): Promise<BoardColumnRow | null> {
  const rows = await conn.update(boardColumns).set(patch).where(eq(boardColumns.id, id)).returning();
  return rows[0] ?? null;
}

export async function deleteColumn(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(boardColumns).where(eq(boardColumns.id, id));
}

/** Bulk-reassigns every task on the deleted column to a fallback column's
 * key, so removing a column never leaves tasks with a dangling status. */
export async function reassignTaskStatus(
  initiativeId: number,
  fromKey: string,
  toKey: string,
  conn: DbLike = db,
): Promise<void> {
  await conn
    .update(tasks)
    .set({ status: toKey })
    .where(sql`${tasks.initiativeId} = ${initiativeId} and ${tasks.status} = ${fromKey}`);
}
