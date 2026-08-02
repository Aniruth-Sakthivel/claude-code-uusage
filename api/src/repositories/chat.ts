/** Data access for team chat: channels, membership, messages. */

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import {
  channelMembers,
  channels,
  chatMessages,
  type ChannelRow,
  type ChatMessageRow,
} from "../db/schema.js";

export async function createChannel(
  name: string,
  createdByUserId: number,
  memberIds: number[],
  conn: DbLike = db,
): Promise<ChannelRow> {
  const rows = await conn.insert(channels).values({ name, kind: "channel", createdByUserId }).returning();
  const channel = rows[0]!;
  const members = Array.from(new Set([createdByUserId, ...memberIds]));
  await conn.insert(channelMembers).values(members.map((userId) => ({ channelId: channel.id, userId })));
  return channel;
}

/** Reuses an existing 1:1 DM channel between the two users, or creates one. */
export async function findOrCreateDm(userA: number, userB: number, conn: DbLike = db): Promise<ChannelRow> {
  const existing = await conn
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channels.kind, "dm"), inArray(channelMembers.userId, [userA, userB])))
    .groupBy(channelMembers.channelId)
    .having(sql`count(distinct ${channelMembers.userId}) = 2 and count(*) = 2`);

  if (existing.length > 0) {
    const rows = await conn.select().from(channels).where(eq(channels.id, existing[0]!.channelId)).limit(1);
    if (rows[0]) return rows[0];
  }

  const rows = await conn.insert(channels).values({ kind: "dm", createdByUserId: userA }).returning();
  const channel = rows[0]!;
  await conn.insert(channelMembers).values([
    { channelId: channel.id, userId: userA },
    { channelId: channel.id, userId: userB },
  ]);
  return channel;
}

export interface ChannelWithMeta extends ChannelRow {
  memberIds: number[];
  lastMessageAt: Date | null;
}

/** Channels (and DMs) the given user belongs to, newest activity first. */
export async function listForUser(userId: number, conn: DbLike = db): Promise<ChannelWithMeta[]> {
  const memberOf = await conn
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .where(eq(channelMembers.userId, userId));
  const ids = memberOf.map((m) => m.channelId);
  if (ids.length === 0) return [];

  const rows = await conn.select().from(channels).where(inArray(channels.id, ids));

  const allMembers = await conn
    .select({ channelId: channelMembers.channelId, userId: channelMembers.userId })
    .from(channelMembers)
    .where(inArray(channelMembers.channelId, ids));
  const membersByChannel = new Map<number, number[]>();
  for (const m of allMembers) {
    const list = membersByChannel.get(m.channelId) ?? [];
    list.push(m.userId);
    membersByChannel.set(m.channelId, list);
  }

  const lastMsg = await conn
    .select({ channelId: chatMessages.channelId, at: sql<Date>`max(${chatMessages.createdAt})` })
    .from(chatMessages)
    .where(inArray(chatMessages.channelId, ids))
    .groupBy(chatMessages.channelId);
  const lastByChannel = new Map(lastMsg.map((m) => [m.channelId, m.at]));

  return rows
    .map((r) => ({
      ...r,
      memberIds: membersByChannel.get(r.id) ?? [],
      lastMessageAt: lastByChannel.get(r.id) ?? null,
    }))
    .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
}

export async function isMember(channelId: number, userId: number, conn: DbLike = db): Promise<boolean> {
  const rows = await conn
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

export async function memberIdsOf(channelId: number, conn: DbLike = db): Promise<number[]> {
  const rows = await conn
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId));
  return rows.map((r) => r.userId);
}

/** `authorUserId: null` posts as a system/automation message, not a person —
 * see services/automation.ts `post_to_channel`. */
export async function createMessage(
  channelId: number,
  authorUserId: number | null,
  authorEmail: string,
  body: string,
  conn: DbLike = db,
): Promise<ChatMessageRow> {
  const rows = await conn
    .insert(chatMessages)
    .values({ channelId, authorUserId, authorEmail, body })
    .returning();
  return rows[0]!;
}

export async function listMessages(
  channelId: number,
  limit = 50,
  conn: DbLike = db,
): Promise<ChatMessageRow[]> {
  const rows = await conn
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.channelId, channelId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  return rows.reverse(); // oldest first, for a natural top-to-bottom thread
}

