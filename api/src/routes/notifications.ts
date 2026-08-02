/** In-app notification routes — every signed-in user reads only their own. */

import type { FastifyInstance } from "fastify";

import { currentUser, requireUser } from "../core/guards.js";
import type { NotificationRow } from "../db/schema.js";
import * as repo from "../repositories/notifications.js";

function notificationOut(n: NotificationRow) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    entity_type: n.entityType,
    entity_id: n.entityId,
    link: n.link,
    read_at: n.readAt?.toISOString() ?? null,
    created_at: n.createdAt.toISOString(),
  };
}

export async function notificationRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireUser };

  app.get("/api/v1/notifications", auth, async (req) => {
    const rows = await repo.listForUser(currentUser(req).id);
    return rows.map(notificationOut);
  });

  app.get("/api/v1/notifications/unread-count", auth, async (req) => ({
    count: await repo.unreadCount(currentUser(req).id),
  }));

  app.post<{ Params: { id: string } }>(
    "/api/v1/notifications/:id/read",
    auth,
    async (req) => {
      const ok = await repo.markRead(Number(req.params.id), currentUser(req).id);
      return { ok };
    },
  );

  app.post("/api/v1/notifications/read-all", auth, async (req) => {
    await repo.markAllRead(currentUser(req).id);
    return { ok: true };
  });
}
