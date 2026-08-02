/**
 * Team chat REST surface: channel/DM management + message history.
 *
 * Real-time delivery of new messages happens over the `/dashboard` WebSocket
 * (see ws/protocol.ts `chat_send`/`chat_message`, ws/server.ts) — this file
 * covers everything that doesn't need to be instant: creating channels,
 * starting DMs, and paginated history for a channel you just opened (or for
 * clients that never connect over WS at all).
 */

import type { FastifyInstance } from "fastify";

import { currentUser, requireStaff } from "../core/guards.js";
import { forbidden } from "../core/errors.js";
import type { ChannelWithMeta } from "../repositories/chat.js";
import * as repo from "../repositories/chat.js";
import { channelCreate, dmCreate, messageCreate } from "../schemas/index.js";
import type { ChatMessageRow } from "../db/schema.js";

function channelOut(c: ChannelWithMeta) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    member_ids: c.memberIds,
    last_message_at: c.lastMessageAt?.toISOString() ?? null,
  };
}

function messageOut(m: ChatMessageRow) {
  return {
    id: m.id,
    channel_id: m.channelId,
    author_user_id: m.authorUserId,
    author_email: m.authorEmail,
    body: m.body,
    created_at: m.createdAt.toISOString(),
  };
}

export async function chatRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireStaff };

  app.get("/api/v1/chat/channels", auth, async (req) =>
    (await repo.listForUser(currentUser(req).id)).map(channelOut),
  );

  app.post("/api/v1/chat/channels", auth, async (req, reply) => {
    const body = channelCreate.parse(req.body ?? {});
    const channel = await repo.createChannel(body.name, currentUser(req).id, body.member_ids);
    const memberIds = await repo.memberIdsOf(channel.id);
    return reply.code(201).send(channelOut({ ...channel, memberIds, lastMessageAt: null }));
  });

  app.post("/api/v1/chat/dm", auth, async (req, reply) => {
    const body = dmCreate.parse(req.body ?? {});
    const channel = await repo.findOrCreateDm(currentUser(req).id, body.user_id);
    const memberIds = await repo.memberIdsOf(channel.id);
    return reply.code(201).send(channelOut({ ...channel, memberIds, lastMessageAt: null }));
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/chat/channels/:id/messages",
    auth,
    async (req) => {
      const channelId = Number(req.params.id);
      if (!(await repo.isMember(channelId, currentUser(req).id))) {
        throw forbidden("Not a member of this channel");
      }
      return (await repo.listMessages(channelId)).map(messageOut);
    },
  );

  /** REST fallback for sending a message — real-time clients use the WS
   * `chat_send` frame instead (see ws/server.ts), but not every client keeps
   * a socket open, and this keeps chat usable without one. */
  app.post<{ Params: { id: string } }>(
    "/api/v1/chat/channels/:id/messages",
    auth,
    async (req, reply) => {
      const channelId = Number(req.params.id);
      const actor = currentUser(req);
      if (!(await repo.isMember(channelId, actor.id))) throw forbidden("Not a member of this channel");
      const body = messageCreate.parse(req.body ?? {});
      const message = await repo.createMessage(channelId, actor.id, actor.email, body.body);
      return reply.code(201).send(messageOut(message));
    },
  );
}
