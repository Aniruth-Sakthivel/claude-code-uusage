/** Data access for in-app notifications. */

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import { notifications, type NotificationRow } from "../db/schema.js";

export interface NotificationInput {
  userId: number;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: number | null;
  link?: string;
}

export async function createNotification(input: NotificationInput, conn: DbLike = db): Promise<void> {
  await conn.insert(notifications).values({
    userId: input.userId,
    type: input.type,
    title: input.title,
    body: input.body ?? "",
    entityType: input.entityType ?? "",
    entityId: input.entityId ?? null,
    link: input.link ?? "",
  });
}

export async function listForUser(
  userId: number,
  limit = 50,
  conn: DbLike = db,
): Promise<NotificationRow[]> {
  return conn
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function unreadCount(userId: number, conn: DbLike = db): Promise<number> {
  const rows = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return rows[0]?.n ?? 0;
}

export async function markRead(id: number, userId: number, conn: DbLike = db): Promise<boolean> {
  const rows = await conn
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

export async function markAllRead(userId: number, conn: DbLike = db): Promise<void> {
  await conn
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}
