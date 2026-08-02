/**
 * PM module routes: initiatives, milestones, tasks, comments, docs, activity.
 *
 * Two auth postures on purpose:
 *   - `requireUser` on everything scoped to a single initiative — every
 *     staff role can fully manage it, and a `client`-role user gets a
 *     narrower read+comment view of whatever's explicitly shared with them
 *     (see services/pm.ts's role checks).
 *   - `requireStaff` on workspace-wide surfaces (wiki, reports, search,
 *     calendar, client-sharing management) that cover every initiative at
 *     once — a client must never reach those even by hand-crafting a
 *     request, since they'd see data outside what was shared with them.
 */

import type { FastifyInstance } from "fastify";

import { currentUser, requireStaff, requireUser } from "../core/guards.js";
import type {
  BoardColumnRow,
  DocRow,
  EpicRow,
  InitiativeRow,
  LabelRow,
  MilestoneRow,
  PmActivityRow,
  SprintRow,
  TaskCommentRow,
  TaskRow,
} from "../db/schema.js";
import * as adminRepo from "../repositories/admin.js";
import type { ClientRef, InitiativeWithCounts } from "../repositories/pm.js";
import * as columnsSvc from "../services/boardColumns.js";
import * as epicsSvc from "../services/epics.js";
import * as labelsSvc from "../services/labels.js";
import * as pm from "../services/pm.js";
import * as sprintsSvc from "../services/sprints.js";
import {
  columnCreate,
  columnUpdate,
  commentCreate,
  docCreate,
  docUpdate,
  epicCreate,
  epicUpdate,
  initiativeCreate,
  initiativeUpdate,
  labelCreate,
  milestoneCreate,
  milestoneUpdate,
  sprintCreate,
  sprintUpdate,
  taskCreate,
  taskLabelAttach,
  taskSprintAssign,
  taskUpdate,
} from "../schemas/index.js";

function initiativeOut(i: InitiativeWithCounts) {
  return {
    id: i.id,
    name: i.name,
    description: i.description,
    status: i.status,
    created_by_user_id: i.createdByUserId,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
    task_count: i.taskCount,
    open_task_count: i.openTaskCount,
  };
}

/** Used where only the base row is available (create/update/get single). */
function initiativeBaseOut(i: InitiativeRow) {
  return initiativeOut({ ...i, taskCount: 0, openTaskCount: 0 });
}

function milestoneOut(m: MilestoneRow) {
  return {
    id: m.id,
    initiative_id: m.initiativeId,
    name: m.name,
    due_date: m.dueDate,
    status: m.status,
    created_at: m.createdAt.toISOString(),
  };
}

interface TaskLike extends TaskRow {
  commentCount?: number;
  labels?: LabelRow[];
}

function taskOut(t: TaskLike) {
  return {
    id: t.id,
    initiative_id: t.initiativeId,
    milestone_id: t.milestoneId,
    epic_id: t.epicId,
    sprint_id: t.sprintId,
    parent_task_id: t.parentTaskId,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    story_points: t.storyPoints,
    assignee_user_id: t.assigneeUserId,
    created_by_user_id: t.createdByUserId,
    due_date: t.dueDate,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
    comment_count: t.commentCount ?? 0,
    labels: (t.labels ?? []).map((l) => ({ id: l.id, name: l.name, color: l.color })),
  };
}

function commentOut(c: TaskCommentRow) {
  return {
    id: c.id,
    task_id: c.taskId,
    author_user_id: c.authorUserId,
    author_email: c.authorEmail,
    body: c.body,
    created_at: c.createdAt.toISOString(),
  };
}

function docOut(d: DocRow) {
  return {
    id: d.id,
    initiative_id: d.initiativeId,
    title: d.title,
    body: d.body,
    created_by_user_id: d.createdByUserId,
    updated_by_user_id: d.updatedByUserId,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

function epicOut(e: EpicRow) {
  return {
    id: e.id,
    initiative_id: e.initiativeId,
    name: e.name,
    description: e.description,
    color: e.color,
    status: e.status,
    created_at: e.createdAt.toISOString(),
  };
}

function sprintOut(s: SprintRow & { taskCount?: number }) {
  return {
    id: s.id,
    initiative_id: s.initiativeId,
    name: s.name,
    start_date: s.startDate,
    end_date: s.endDate,
    status: s.status,
    created_at: s.createdAt.toISOString(),
    task_count: s.taskCount ?? 0,
  };
}

function columnOut(c: BoardColumnRow) {
  return {
    id: c.id,
    initiative_id: c.initiativeId,
    key: c.key,
    label: c.label,
    position: c.position,
    is_done_column: c.isDoneColumn,
  };
}

function labelOut(l: LabelRow) {
  return { id: l.id, name: l.name, color: l.color };
}

function activityOut(a: PmActivityRow) {
  return {
    id: a.id,
    actor_email: a.actorEmail,
    action: a.action,
    entity_type: a.entityType,
    entity_id: a.entityId,
    detail: a.detail,
    at: a.at.toISOString(),
  };
}

function clientOut(c: ClientRef) {
  return { user_id: c.userId, email: c.email, full_name: c.fullName };
}

export async function pmRoutes(app: FastifyInstance) {
  const auth = { preHandler: requireUser };
  const staffOnly = { preHandler: requireStaff };

  /**
   * Assignee picker data. `/admin/users` is gated by `manage_users`, which
   * most roles don't have — but PM is open to every signed-in user, so the
   * task-assignment picker needs its own minimal, unprivileged listing (id +
   * name only, no role/system data) rather than reusing the admin endpoint.
   * Staff-only: a client never assigns tasks.
   */
  app.get("/api/v1/pm/assignees", staffOnly, async () => {
    const users = await adminRepo.listUsers();
    return users
      .filter((u) => u.isActive && u.role !== "client")
      .map((u) => ({ id: u.id, email: u.email, full_name: u.fullName }));
  });

  /** Active client-role users, for the "share with client" picker. */
  app.get("/api/v1/pm/clients", staffOnly, async () => {
    const users = await adminRepo.listUsers();
    return users.filter((u) => u.isActive && u.role === "client").map((u) => ({
      id: u.id,
      email: u.email,
      full_name: u.fullName,
    }));
  });

  // ── initiatives ────────────────────────────────────────────────────────────
  app.get("/api/v1/initiatives", auth, async (req) =>
    (await pm.listInitiatives(currentUser(req))).map(initiativeOut),
  );

  app.post("/api/v1/initiatives", auth, async (req, reply) => {
    const body = initiativeCreate.parse(req.body ?? {});
    const initiative = await pm.createInitiative(currentUser(req), body);
    return reply.code(201).send(initiativeBaseOut(initiative));
  });

  app.get<{ Params: { id: string } }>("/api/v1/initiatives/:id", auth, async (req) =>
    initiativeBaseOut(await pm.getInitiative(currentUser(req), Number(req.params.id))),
  );

  app.patch<{ Params: { id: string } }>("/api/v1/initiatives/:id", auth, async (req) => {
    const body = initiativeUpdate.parse(req.body ?? {});
    return initiativeBaseOut(await pm.updateInitiative(currentUser(req), Number(req.params.id), body));
  });

  app.delete<{ Params: { id: string } }>("/api/v1/initiatives/:id", auth, async (req, reply) => {
    await pm.deleteInitiative(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  // ── client sharing ────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/clients",
    staffOnly,
    async (req) => (await pm.listClientsForInitiative(currentUser(req), Number(req.params.id))).map(clientOut),
  );

  app.post<{ Params: { id: string }; Body: { user_id: number } }>(
    "/api/v1/initiatives/:id/clients",
    staffOnly,
    async (req, reply) => {
      await pm.shareInitiativeWithClient(currentUser(req), Number(req.params.id), Number(req.body.user_id));
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/initiatives/:id/clients/:userId",
    staffOnly,
    async (req, reply) => {
      await pm.unshareInitiativeFromClient(currentUser(req), Number(req.params.id), Number(req.params.userId));
      return reply.code(204).send();
    },
  );

  // ── milestones ─────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/milestones",
    auth,
    async (req) => (await pm.listMilestones(currentUser(req), Number(req.params.id))).map(milestoneOut),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/milestones",
    auth,
    async (req, reply) => {
      const body = milestoneCreate.parse(req.body ?? {});
      const milestone = await pm.createMilestone(currentUser(req), Number(req.params.id), {
        name: body.name,
        dueDate: body.due_date,
      });
      return reply.code(201).send(milestoneOut(milestone));
    },
  );

  app.patch<{ Params: { id: string } }>("/api/v1/milestones/:id", auth, async (req) => {
    const body = milestoneUpdate.parse(req.body ?? {});
    const milestone = await pm.updateMilestone(currentUser(req), Number(req.params.id), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.due_date !== undefined ? { dueDate: body.due_date } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    return milestoneOut(milestone);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/milestones/:id", auth, async (req, reply) => {
    await pm.deleteMilestone(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  // ── tasks ──────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/tasks",
    auth,
    async (req) => (await pm.listTasks(currentUser(req), Number(req.params.id))).map(taskOut),
  );

  app.post<{ Params: { id: string } }>("/api/v1/initiatives/:id/tasks", auth, async (req, reply) => {
    const body = taskCreate.parse(req.body ?? {});
    const task = await pm.createTask(currentUser(req), Number(req.params.id), {
      title: body.title,
      description: body.description,
      milestoneId: body.milestone_id,
      assigneeUserId: body.assignee_user_id,
      dueDate: body.due_date,
      epicId: body.epic_id,
      sprintId: body.sprint_id,
      parentTaskId: body.parent_task_id,
      priority: body.priority,
      storyPoints: body.story_points,
      status: body.status,
    });
    return reply.code(201).send(taskOut(task));
  });

  app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", auth, async (req) =>
    taskOut(await pm.getTask(currentUser(req), Number(req.params.id))),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/tasks/:id/subtasks",
    auth,
    async (req) => (await pm.listSubtasks(currentUser(req), Number(req.params.id))).map(taskOut),
  );

  app.patch<{ Params: { id: string } }>("/api/v1/tasks/:id", auth, async (req) => {
    const body = taskUpdate.parse(req.body ?? {});
    const task = await pm.updateTask(currentUser(req), Number(req.params.id), {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.milestone_id !== undefined ? { milestoneId: body.milestone_id } : {}),
      ...(body.assignee_user_id !== undefined ? { assigneeUserId: body.assignee_user_id } : {}),
      ...(body.due_date !== undefined ? { dueDate: body.due_date } : {}),
      ...(body.epic_id !== undefined ? { epicId: body.epic_id } : {}),
      ...(body.sprint_id !== undefined ? { sprintId: body.sprint_id } : {}),
      ...(body.parent_task_id !== undefined ? { parentTaskId: body.parent_task_id } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.story_points !== undefined ? { storyPoints: body.story_points } : {}),
    });
    return taskOut(task);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/tasks/:id", auth, async (req, reply) => {
    await pm.deleteTask(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  // ── labels on a task ─────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/labels", auth, async (req, reply) => {
    const body = taskLabelAttach.parse(req.body ?? {});
    await labelsSvc.attachLabel(currentUser(req), Number(req.params.id), body.label_id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; labelId: string } }>(
    "/api/v1/tasks/:id/labels/:labelId",
    auth,
    async (req, reply) => {
      await labelsSvc.detachLabel(currentUser(req), Number(req.params.id), Number(req.params.labelId));
      return reply.code(204).send();
    },
  );

  // ── sprint assignment for a task ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/sprint", auth, async (req, reply) => {
    const body = taskSprintAssign.parse(req.body ?? {});
    await sprintsSvc.assignTaskToSprint(currentUser(req), Number(req.params.id), body.sprint_id);
    return reply.code(204).send();
  });

  // ── task comments ─────────────────────────────────────────────────────────
  // `auth` (not staffOnly): clients may comment on tasks in shared initiatives.
  app.get<{ Params: { id: string } }>(
    "/api/v1/tasks/:id/comments",
    auth,
    async (req) => (await pm.listComments(currentUser(req), Number(req.params.id))).map(commentOut),
  );

  app.post<{ Params: { id: string } }>("/api/v1/tasks/:id/comments", auth, async (req, reply) => {
    const body = commentCreate.parse(req.body ?? {});
    const comment = await pm.createComment(currentUser(req), Number(req.params.id), body.body);
    return reply.code(201).send(commentOut(comment));
  });

  // ── docs ───────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/docs",
    auth,
    async (req) => (await pm.listDocs(currentUser(req), Number(req.params.id))).map(docOut),
  );

  app.post<{ Params: { id: string } }>("/api/v1/initiatives/:id/docs", auth, async (req, reply) => {
    const body = docCreate.parse(req.body ?? {});
    const doc = await pm.createDoc(currentUser(req), Number(req.params.id), body);
    return reply.code(201).send(docOut(doc));
  });

  app.get<{ Params: { id: string } }>("/api/v1/docs/:id", auth, async (req) =>
    docOut(await pm.getDoc(currentUser(req), Number(req.params.id))),
  );

  app.patch<{ Params: { id: string } }>("/api/v1/docs/:id", auth, async (req) => {
    const body = docUpdate.parse(req.body ?? {});
    return docOut(await pm.updateDoc(currentUser(req), Number(req.params.id), body));
  });

  app.delete<{ Params: { id: string } }>("/api/v1/docs/:id", auth, async (req, reply) => {
    await pm.deleteDoc(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  // ── activity feed ─────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/activity",
    auth,
    async (req) => (await pm.listActivity(currentUser(req), Number(req.params.id))).map(activityOut),
  );

  // ── epics ──────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/epics",
    auth,
    async (req) => (await epicsSvc.listEpics(currentUser(req), Number(req.params.id))).map(epicOut),
  );

  app.post<{ Params: { id: string } }>("/api/v1/initiatives/:id/epics", auth, async (req, reply) => {
    const body = epicCreate.parse(req.body ?? {});
    const epic = await epicsSvc.createEpic(currentUser(req), Number(req.params.id), body);
    return reply.code(201).send(epicOut(epic));
  });

  app.patch<{ Params: { id: string } }>("/api/v1/epics/:id", auth, async (req) => {
    const body = epicUpdate.parse(req.body ?? {});
    return epicOut(await epicsSvc.updateEpic(currentUser(req), Number(req.params.id), body));
  });

  app.delete<{ Params: { id: string } }>("/api/v1/epics/:id", auth, async (req, reply) => {
    await epicsSvc.deleteEpic(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  // ── sprints + backlog ─────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/sprints",
    auth,
    async (req) => (await sprintsSvc.listSprints(currentUser(req), Number(req.params.id))).map(sprintOut),
  );

  app.post<{ Params: { id: string } }>("/api/v1/initiatives/:id/sprints", auth, async (req, reply) => {
    const body = sprintCreate.parse(req.body ?? {});
    const sprint = await sprintsSvc.createSprint(currentUser(req), Number(req.params.id), {
      name: body.name,
      startDate: body.start_date,
      endDate: body.end_date,
    });
    return reply.code(201).send(sprintOut(sprint));
  });

  app.patch<{ Params: { id: string } }>("/api/v1/sprints/:id", auth, async (req) => {
    const body = sprintUpdate.parse(req.body ?? {});
    const sprint = await sprintsSvc.updateSprint(currentUser(req), Number(req.params.id), {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.start_date !== undefined ? { startDate: body.start_date } : {}),
      ...(body.end_date !== undefined ? { endDate: body.end_date } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    });
    return sprintOut(sprint);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/sprints/:id", auth, async (req, reply) => {
    await sprintsSvc.deleteSprint(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/backlog",
    auth,
    async (req) => (await sprintsSvc.listBacklog(currentUser(req), Number(req.params.id))).map(taskOut),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/sprints/:id/tasks",
    auth,
    async (req) => (await sprintsSvc.listSprintTasks(currentUser(req), Number(req.params.id))).map(taskOut),
  );

  // ── board columns (custom workflow) ──────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/initiatives/:id/columns",
    auth,
    async (req) => (await columnsSvc.listColumns(currentUser(req), Number(req.params.id))).map(columnOut),
  );

  app.post<{ Params: { id: string } }>("/api/v1/initiatives/:id/columns", auth, async (req, reply) => {
    const body = columnCreate.parse(req.body ?? {});
    const column = await columnsSvc.createColumn(currentUser(req), Number(req.params.id), body.key, body.label);
    return reply.code(201).send(columnOut(column));
  });

  app.patch<{ Params: { id: string } }>("/api/v1/columns/:id", auth, async (req) => {
    const body = columnUpdate.parse(req.body ?? {});
    const column = await columnsSvc.updateColumn(currentUser(req), Number(req.params.id), {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
      ...(body.is_done_column !== undefined ? { isDoneColumn: body.is_done_column } : {}),
    });
    return columnOut(column);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/columns/:id", auth, async (req, reply) => {
    await columnsSvc.deleteColumn(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  // ── labels (workspace-wide) ───────────────────────────────────────────────
  app.get("/api/v1/labels", auth, async () => (await labelsSvc.listLabels()).map(labelOut));

  app.post("/api/v1/labels", staffOnly, async (req, reply) => {
    const body = labelCreate.parse(req.body ?? {});
    const label = await labelsSvc.createLabel(currentUser(req), body.name, body.color);
    return reply.code(201).send(labelOut(label));
  });

  app.delete<{ Params: { id: string } }>("/api/v1/labels/:id", staffOnly, async (req, reply) => {
    await labelsSvc.deleteLabel(currentUser(req), Number(req.params.id));
    return reply.code(204).send();
  });

  // ── workspace wiki (docs with no initiative) ─────────────────────────────
  app.get("/api/v1/workspace/docs", staffOnly, async (req) =>
    (await pm.listWikiPages(currentUser(req))).map(docOut),
  );

  app.post("/api/v1/workspace/docs", staffOnly, async (req, reply) => {
    const body = docCreate.parse(req.body ?? {});
    const doc = await pm.createWikiPage(currentUser(req), body);
    return reply.code(201).send(docOut(doc));
  });

  // ── reports/analytics ────────────────────────────────────────────────────
  app.get("/api/v1/workspace/reports", staffOnly, async (req) => {
    const r = await pm.getReports(currentUser(req));
    return {
      initiatives_by_status: r.initiativesByStatus,
      tasks_by_status: r.tasksByStatus,
      workload: r.workload.map((w) => ({
        user_id: w.userId,
        email: w.email,
        full_name: w.fullName,
        n: w.n,
      })),
      completed_by_day: r.completedByDay,
    };
  });

  // ── global search ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>("/api/v1/workspace/search", staffOnly, async (req) =>
    pm.search(currentUser(req), req.query.q ?? ""),
  );

  // ── calendar (workspace-wide) ────────────────────────────────────────────
  app.get("/api/v1/workspace/calendar", staffOnly, async (req) =>
    (await pm.getCalendar(currentUser(req))).map((item) => ({
      kind: item.kind,
      id: item.id,
      initiative_id: item.initiativeId,
      initiative_name: item.initiativeName,
      title: item.title,
      due_date: item.dueDate,
      status: item.status,
    })),
  );
}
