/**
 * PM module business logic.
 *
 * Open to every signed-in user — no capability check anywhere in this file
 * (see api/src/core/rbac.ts: every role already gets `connect_own_pc`, the
 * existing precedent for "any user manages their own things"; this module
 * extends that same posture to initiatives/tasks/docs). `actor: Principal` is
 * threaded through purely to populate `actorUserId`/`actorEmail` on the
 * activity row, not to gate anything.
 *
 * Every mutation wraps its repo write + an activity-log write in one
 * transaction, mirroring `enqueueCommand` in services/commands.ts (repo write
 * + `writeAudit`, same transactional pairing). Deletes write their activity
 * row *before* the delete executes, so it references a still-valid actor.
 */

import { db } from "../db/client.js";
import { badRequest, forbidden, notFound } from "../core/errors.js";
import { CLIENT, type Principal } from "../core/rbac.js";
import * as columnsRepo from "../repositories/boardColumns.js";
import * as labelsRepo from "../repositories/labels.js";
import * as notifyRepo from "../repositories/notifications.js";
import * as repo from "../repositories/pm.js";
import { runAutomations, type TriggerContext, type TriggerType } from "./automation.js";

/** Blocks every PM mutation for the client-portal role — clients get
 * read-only access (plus commenting) to whatever's explicitly shared with
 * them, never create/edit/delete. See core/rbac.ts CLIENT. Exported so the
 * epics/sprints/board-column/label service modules can reuse the same
 * check rather than re-deriving it. */
export function assertStaff(actor: Principal) {
  if (actor.role === CLIENT) throw forbidden("Not available to client accounts");
}

/** Throws the same `notFound` a nonexistent initiative would — a client
 * probing an unshared initiative id learns nothing from the error shape. */
export async function assertClientCanSee(actor: Principal, initiativeId: number) {
  if (actor.role !== CLIENT) return;
  if (!(await repo.isSharedWithClient(initiativeId, actor.id))) throw notFound("Initiative not found");
}

/** Never lets a broken automation subsystem affect the PM mutation that
 * triggered it — `runAutomations` already catches per-rule errors, but this
 * is the outer safety net for anything that slips past that (e.g. the rule
 * lookup query itself failing). */
async function fireAutomations(trigger: TriggerType, ctx: TriggerContext): Promise<void> {
  try {
    await runAutomations(trigger, ctx);
  } catch {
    // swallowed by design — see comment above
  }
}

function activity(
  initiativeId: number,
  actor: Principal,
  action: string,
  entityType: string,
  entityId: number,
  detail = "",
) {
  return { initiativeId, actorUserId: actor.id, actorEmail: actor.email, action, entityType, entityId, detail };
}

// ── initiatives ───────────────────────────────────────────────────────────────
export async function createInitiative(actor: Principal, input: repo.InitiativeCreateInput) {
  assertStaff(actor);
  return db.transaction(async (tx) => {
    const initiative = await repo.createInitiative(input, actor.id, tx);
    await columnsRepo.seedDefaultColumns(initiative.id, tx);
    await repo.writeActivity(
      activity(initiative.id, actor, "initiative.created", "initiative", initiative.id, initiative.name),
      tx,
    );
    return initiative;
  });
}

export function listInitiatives(actor: Principal) {
  if (actor.role === CLIENT) {
    return repo.listSharedInitiativeIds(actor.id).then((ids) => repo.listInitiativesByIds(ids));
  }
  return repo.listInitiatives();
}

export async function getInitiative(actor: Principal, id: number) {
  await assertClientCanSee(actor, id);
  const initiative = await repo.getInitiative(id);
  if (!initiative) throw notFound("Initiative not found");
  return initiative;
}

export async function updateInitiative(actor: Principal, id: number, patch: repo.InitiativeUpdateInput) {
  assertStaff(actor);
  return db.transaction(async (tx) => {
    const initiative = await repo.updateInitiative(id, patch, tx);
    if (!initiative) throw notFound("Initiative not found");
    await repo.writeActivity(
      activity(id, actor, "initiative.updated", "initiative", id, initiative.name),
      tx,
    );
    return initiative;
  });
}

export async function deleteInitiative(actor: Principal, id: number) {
  assertStaff(actor);
  const initiative = await repo.getInitiative(id);
  if (!initiative) throw notFound("Initiative not found");
  await db.transaction(async (tx) => {
    await repo.writeActivity(
      activity(id, actor, "initiative.deleted", "initiative", id, initiative.name),
      tx,
    );
    await repo.deleteInitiative(id, tx);
  });
}

// ── client sharing ──────────────────────────────────────────────────────────
export async function shareInitiativeWithClient(actor: Principal, initiativeId: number, clientUserId: number) {
  assertStaff(actor);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  await repo.shareInitiativeWithClient(initiativeId, clientUserId);
}

export async function unshareInitiativeFromClient(actor: Principal, initiativeId: number, clientUserId: number) {
  assertStaff(actor);
  await repo.unshareInitiativeFromClient(initiativeId, clientUserId);
}

export async function listClientsForInitiative(actor: Principal, initiativeId: number) {
  assertStaff(actor);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return repo.listClientsForInitiative(initiativeId);
}

// ── milestones ───────────────────────────────────────────────────────────────
export async function createMilestone(
  actor: Principal,
  initiativeId: number,
  input: repo.MilestoneCreateInput,
) {
  assertStaff(actor);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return db.transaction(async (tx) => {
    const milestone = await repo.createMilestone(initiativeId, input, actor.id, tx);
    await repo.writeActivity(
      activity(initiativeId, actor, "milestone.created", "milestone", milestone.id, milestone.name),
      tx,
    );
    return milestone;
  });
}

export async function listMilestones(actor: Principal, initiativeId: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return repo.listMilestones(initiativeId);
}

export async function updateMilestone(actor: Principal, id: number, patch: repo.MilestoneUpdateInput) {
  assertStaff(actor);
  const existing = await repo.getMilestone(id);
  if (!existing) throw notFound("Milestone not found");
  return db.transaction(async (tx) => {
    const milestone = await repo.updateMilestone(id, patch, tx);
    const action = patch.status ? "milestone.status_changed" : "milestone.updated";
    const detail = patch.status ? `${existing.status} -> ${patch.status}` : (milestone?.name ?? "");
    await repo.writeActivity(activity(existing.initiativeId, actor, action, "milestone", id, detail), tx);
    return milestone!;
  });
}

export async function deleteMilestone(actor: Principal, id: number) {
  assertStaff(actor);
  const existing = await repo.getMilestone(id);
  if (!existing) throw notFound("Milestone not found");
  await db.transaction(async (tx) => {
    await repo.writeActivity(
      activity(existing.initiativeId, actor, "milestone.deleted", "milestone", id, existing.name),
      tx,
    );
    await repo.deleteMilestone(id, tx);
  });
}

/** Validates a requested status against the initiative's actual configured
 * columns (custom workflow), or defaults to the first column when none was
 * given. `ensureColumns` seeds the three defaults for initiatives that
 * predate this feature, so this never fails on "no columns configured". */
async function resolveTaskStatus(
  initiativeId: number,
  requested: string | undefined,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<string> {
  const columns = await columnsRepo.ensureColumns(initiativeId, tx);
  if (!requested) return columns[0]!.key;
  if (!columns.some((c) => c.key === requested)) {
    throw badRequest(`Unknown status "${requested}" for this initiative's workflow`);
  }
  return requested;
}

// ── tasks ────────────────────────────────────────────────────────────────────
export async function createTask(actor: Principal, initiativeId: number, input: repo.TaskCreateInput) {
  assertStaff(actor);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  const task = await db.transaction(async (tx) => {
    const status = await resolveTaskStatus(initiativeId, input.status, tx);
    const task = await repo.createTask(initiativeId, { ...input, status }, actor.id, tx);
    await repo.writeActivity(activity(initiativeId, actor, "task.created", "task", task.id, task.title), tx);
    if (task.assigneeUserId && task.assigneeUserId !== actor.id) {
      await notifyRepo.createNotification(
        {
          userId: task.assigneeUserId,
          type: "task_assigned",
          title: `${actor.email} assigned you a task`,
          body: task.title,
          entityType: "task",
          entityId: task.id,
          link: `/workspace/initiatives/${initiativeId}`,
        },
        tx,
      );
    }
    return task;
  });
  // Never inside the transaction above — a misconfigured automation rule
  // must not be able to roll back the task that triggered it.
  await fireAutomations("task_created", {
    taskId: task.id,
    initiativeId,
    title: task.title,
    assigneeUserId: task.assigneeUserId,
  });
  if (task.assigneeUserId) {
    await fireAutomations("task_assigned", {
      taskId: task.id,
      initiativeId,
      title: task.title,
      assigneeUserId: task.assigneeUserId,
    });
  }
  return task;
}

export async function listTasks(actor: Principal, initiativeId: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  const tasks = await repo.listTasks(initiativeId);
  const labelsByTask = await labelsRepo.listLabelsForTasks(tasks.map((t) => t.id));
  return tasks.map((t) => ({ ...t, labels: labelsByTask.get(t.id) ?? [] }));
}

export async function getTask(actor: Principal, id: number) {
  const task = await repo.getTask(id);
  if (!task) throw notFound("Task not found");
  await assertClientCanSee(actor, task.initiativeId);
  const labels = await labelsRepo.listLabelsForTask(id);
  return { ...task, labels };
}

export async function listSubtasks(actor: Principal, parentTaskId: number) {
  const parent = await repo.getTask(parentTaskId);
  if (!parent) throw notFound("Task not found");
  await assertClientCanSee(actor, parent.initiativeId);
  const subtasks = await repo.listSubtasks(parentTaskId);
  const labelsByTask = await labelsRepo.listLabelsForTasks(subtasks.map((t) => t.id));
  return subtasks.map((t) => ({ ...t, labels: labelsByTask.get(t.id) ?? [] }));
}

export async function updateTask(actor: Principal, id: number, patch: repo.TaskUpdateInput) {
  assertStaff(actor);
  const existing = await repo.getTask(id);
  if (!existing) throw notFound("Task not found");
  const task = await db.transaction(async (tx) => {
    if (patch.status) {
      patch = { ...patch, status: await resolveTaskStatus(existing.initiativeId, patch.status, tx) };
    }
    const task = await repo.updateTask(id, patch, tx);
    const action = patch.status ? "task.status_changed" : "task.updated";
    const detail = patch.status ? `${existing.status} -> ${patch.status}` : (task?.title ?? "");
    await repo.writeActivity(activity(existing.initiativeId, actor, action, "task", id, detail), tx);
    if (
      patch.assigneeUserId !== undefined &&
      patch.assigneeUserId !== null &&
      patch.assigneeUserId !== existing.assigneeUserId &&
      patch.assigneeUserId !== actor.id
    ) {
      await notifyRepo.createNotification(
        {
          userId: patch.assigneeUserId,
          type: "task_assigned",
          title: `${actor.email} assigned you a task`,
          body: task!.title,
          entityType: "task",
          entityId: id,
          link: `/workspace/initiatives/${existing.initiativeId}`,
        },
        tx,
      );
    }
    return task!;
  });

  if (patch.status && patch.status !== existing.status) {
    await fireAutomations("task_status_changed", {
      taskId: id,
      initiativeId: existing.initiativeId,
      title: task.title,
      fromStatus: existing.status,
      toStatus: patch.status,
      assigneeUserId: task.assigneeUserId,
    });
  }
  if (
    patch.assigneeUserId !== undefined &&
    patch.assigneeUserId !== null &&
    patch.assigneeUserId !== existing.assigneeUserId
  ) {
    await fireAutomations("task_assigned", {
      taskId: id,
      initiativeId: existing.initiativeId,
      title: task.title,
      assigneeUserId: task.assigneeUserId,
    });
  }
  return task;
}

export async function deleteTask(actor: Principal, id: number) {
  assertStaff(actor);
  const existing = await repo.getTask(id);
  if (!existing) throw notFound("Task not found");
  await db.transaction(async (tx) => {
    await repo.writeActivity(
      activity(existing.initiativeId, actor, "task.deleted", "task", id, existing.title),
      tx,
    );
    await repo.deleteTask(id, tx);
  });
}

// ── task comments ────────────────────────────────────────────────────────────
// Deliberately not staff-only: a client giving feedback on shared work is
// exactly what the portal is for. Access is still scoped to shared
// initiatives via assertClientCanSee.
export async function createComment(actor: Principal, taskId: number, body: string) {
  const task = await repo.getTask(taskId);
  if (!task) throw notFound("Task not found");
  await assertClientCanSee(actor, task.initiativeId);
  const comment = await db.transaction(async (tx) => {
    const comment = await repo.createComment(taskId, body, actor.id, actor.email, tx);
    await repo.writeActivity(
      activity(task.initiativeId, actor, "task.commented", "task", taskId, body.slice(0, 200)),
      tx,
    );
    // Notify the assignee and the task's creator (if different from the
    // commenter and from each other) — a dedup Set, not two unconditional
    // inserts, so the creator==assignee case doesn't double-notify.
    const recipients = new Set(
      [task.assigneeUserId, task.createdByUserId].filter(
        (id): id is number => id !== null && id !== actor.id,
      ),
    );
    for (const userId of recipients) {
      await notifyRepo.createNotification(
        {
          userId,
          type: "task_commented",
          title: `${actor.email} commented on "${task.title}"`,
          body: body.slice(0, 200),
          entityType: "task",
          entityId: taskId,
          link: `/workspace/initiatives/${task.initiativeId}`,
        },
        tx,
      );
    }
    return comment;
  });

  await fireAutomations("task_commented", {
    taskId,
    initiativeId: task.initiativeId,
    title: task.title,
    assigneeUserId: task.assigneeUserId,
    commentBody: body,
  });
  return comment;
}

export async function listComments(actor: Principal, taskId: number) {
  const task = await repo.getTask(taskId);
  if (!task) throw notFound("Task not found");
  await assertClientCanSee(actor, task.initiativeId);
  return repo.listComments(taskId);
}

// ── docs ─────────────────────────────────────────────────────────────────────
export async function createDoc(actor: Principal, initiativeId: number, input: repo.DocCreateInput) {
  assertStaff(actor);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return db.transaction(async (tx) => {
    const doc = await repo.createDoc(initiativeId, input, actor.id, tx);
    await repo.writeActivity(activity(initiativeId, actor, "doc.created", "doc", doc.id, doc.title), tx);
    return doc;
  });
}

export async function listDocs(actor: Principal, initiativeId: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return repo.listDocs(initiativeId);
}

export async function getDoc(actor: Principal, id: number) {
  const doc = await repo.getDoc(id);
  if (!doc) throw notFound("Doc not found");
  // A workspace wiki page (initiativeId null) is staff-only; a per-initiative
  // doc is visible to a client only if that initiative is shared with them.
  if (doc.initiativeId === null) assertStaff(actor);
  else await assertClientCanSee(actor, doc.initiativeId);
  return doc;
}

export async function updateDoc(actor: Principal, id: number, patch: repo.DocUpdateInput) {
  assertStaff(actor);
  const existing = await repo.getDoc(id);
  if (!existing) throw notFound("Doc not found");
  return db.transaction(async (tx) => {
    const doc = await repo.updateDoc(id, patch, actor.id, tx);
    // Workspace-wide wiki pages (initiativeId null) have no per-initiative
    // activity feed to write into — pmActivity.initiativeId is required.
    if (existing.initiativeId !== null) {
      await repo.writeActivity(
        activity(existing.initiativeId, actor, "doc.updated", "doc", id, doc?.title ?? ""),
        tx,
      );
    }
    return doc!;
  });
}

export async function deleteDoc(actor: Principal, id: number) {
  assertStaff(actor);
  const existing = await repo.getDoc(id);
  if (!existing) throw notFound("Doc not found");
  await db.transaction(async (tx) => {
    if (existing.initiativeId !== null) {
      await repo.writeActivity(
        activity(existing.initiativeId, actor, "doc.deleted", "doc", id, existing.title),
        tx,
      );
    }
    await repo.deleteDoc(id, tx);
  });
}

// ── workspace wiki (docs with no initiative) ──────────────────────────────────
// Staff-only, defensively re-checked here even though the routes already use
// requireStaff — the wiki has no per-page sharing concept the way
// initiatives do, so a client must never reach it by any path.
export async function createWikiPage(actor: Principal, input: repo.DocCreateInput) {
  assertStaff(actor);
  return repo.createDoc(null, input, actor.id);
}

export function listWikiPages(actor: Principal) {
  assertStaff(actor);
  return repo.listWorkspaceDocs();
}

// ── activity feed ────────────────────────────────────────────────────────────
export async function listActivity(actor: Principal, initiativeId: number, limit?: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await repo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return repo.listActivity(initiativeId, limit);
}

// ── reports/analytics ────────────────────────────────────────────────────────
export function getReports(actor: Principal) {
  assertStaff(actor);
  return repo.getReportsSummary();
}

// ── global search ────────────────────────────────────────────────────────────
export async function search(actor: Principal, query: string) {
  assertStaff(actor);
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  return repo.search(trimmed);
}

// ── calendar ─────────────────────────────────────────────────────────────────
export async function getCalendar(actor: Principal) {
  assertStaff(actor);
  const [taskItems, milestoneItems] = await Promise.all([
    repo.listCalendarTasks(),
    repo.listCalendarMilestones(),
  ]);
  return [...taskItems, ...milestoneItems].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}
