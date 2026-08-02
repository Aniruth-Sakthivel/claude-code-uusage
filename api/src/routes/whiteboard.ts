/**
 * Whiteboard REST surface: board CRUD + initial element load. Live
 * editing (adding/moving/deleting notes and strokes) goes over the
 * dashboard WebSocket instead — see ws/protocol.ts `board_op`/`board_update`/
 * `board_delete` and ws/server.ts. A board has no "offline send" the way
 * chat does, so there's no REST write path to duplicate that logic.
 */

import type { FastifyInstance } from "fastify";

import { currentUser, requireStaff } from "../core/guards.js";
import { notFound } from "../core/errors.js";
import type { WhiteboardElementRow, WhiteboardRow } from "../db/schema.js";
import * as repo from "../repositories/whiteboard.js";
import { boardCreate } from "../schemas/index.js";

function boardOut(b: WhiteboardRow) {
  return { id: b.id, name: b.name, created_at: b.createdAt.toISOString() };
}

function elementOut(e: WhiteboardElementRow) {
  return {
    id: e.id,
    board_id: e.boardId,
    kind: e.kind,
    data: JSON.parse(e.data || "{}"),
    created_at: e.createdAt.toISOString(),
    updated_at: e.updatedAt.toISOString(),
  };
}

export async function whiteboardRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireStaff };

  app.get("/api/v1/workspace/boards", auth, async () => (await repo.listBoards()).map(boardOut));

  app.post("/api/v1/workspace/boards", auth, async (req, reply) => {
    const body = boardCreate.parse(req.body ?? {});
    const board = await repo.createBoard(body.name, currentUser(req).id);
    return reply.code(201).send(boardOut(board));
  });

  app.delete<{ Params: { id: string } }>("/api/v1/workspace/boards/:id", auth, async (req, reply) => {
    if (!(await repo.getBoard(Number(req.params.id)))) throw notFound("Board not found");
    await repo.deleteBoard(Number(req.params.id));
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/workspace/boards/:id/elements",
    auth,
    async (req) => (await repo.listElements(Number(req.params.id))).map(elementOut),
  );
}
