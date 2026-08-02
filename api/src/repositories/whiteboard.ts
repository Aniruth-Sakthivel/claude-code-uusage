/** Data access for whiteboards and their elements (notes/strokes). */

import { desc, eq } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import {
  whiteboardElements,
  whiteboards,
  type WhiteboardElementRow,
  type WhiteboardRow,
} from "../db/schema.js";

export async function createBoard(
  name: string,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<WhiteboardRow> {
  const rows = await conn.insert(whiteboards).values({ name, createdByUserId }).returning();
  return rows[0]!;
}

export async function listBoards(conn: DbLike = db): Promise<WhiteboardRow[]> {
  return conn.select().from(whiteboards).orderBy(desc(whiteboards.createdAt));
}

export async function getBoard(id: number, conn: DbLike = db): Promise<WhiteboardRow | null> {
  const rows = await conn.select().from(whiteboards).where(eq(whiteboards.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function deleteBoard(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(whiteboards).where(eq(whiteboards.id, id));
}

export async function listElements(boardId: number, conn: DbLike = db): Promise<WhiteboardElementRow[]> {
  return conn
    .select()
    .from(whiteboardElements)
    .where(eq(whiteboardElements.boardId, boardId))
    .orderBy(whiteboardElements.createdAt);
}

export async function createElement(
  boardId: number,
  kind: "note" | "stroke",
  data: Record<string, unknown>,
  createdByUserId: number | null,
  conn: DbLike = db,
): Promise<WhiteboardElementRow> {
  const rows = await conn
    .insert(whiteboardElements)
    .values({ boardId, kind, data: JSON.stringify(data), createdByUserId })
    .returning();
  return rows[0]!;
}

export async function updateElement(
  id: number,
  data: Record<string, unknown>,
  conn: DbLike = db,
): Promise<WhiteboardElementRow | null> {
  const rows = await conn
    .update(whiteboardElements)
    .set({ data: JSON.stringify(data), updatedAt: new Date() })
    .where(eq(whiteboardElements.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteElement(id: number, conn: DbLike = db): Promise<void> {
  await conn.delete(whiteboardElements).where(eq(whiteboardElements.id, id));
}
