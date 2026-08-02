/** Sprint + backlog management. */

import { db } from "../db/client.js";
import { notFound } from "../core/errors.js";
import type { Principal } from "../core/rbac.js";
import * as pmRepo from "../repositories/pm.js";
import * as sprintsRepo from "../repositories/sprints.js";
import { assertClientCanSee, assertStaff } from "./pm.js";

function activity(initiativeId: number, actor: Principal, action: string, entityId: number, detail: string) {
  return { initiativeId, actorUserId: actor.id, actorEmail: actor.email, action, entityType: "sprint", entityId, detail };
}

export async function createSprint(actor: Principal, initiativeId: number, input: sprintsRepo.SprintCreateInput) {
  assertStaff(actor);
  if (!(await pmRepo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return db.transaction(async (tx) => {
    const sprint = await sprintsRepo.createSprint(initiativeId, input, actor.id, tx);
    await pmRepo.writeActivity(activity(initiativeId, actor, "sprint.created", sprint.id, sprint.name), tx);
    return sprint;
  });
}

export async function listSprints(actor: Principal, initiativeId: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await pmRepo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return sprintsRepo.listSprints(initiativeId);
}

export async function updateSprint(actor: Principal, id: number, patch: sprintsRepo.SprintUpdateInput) {
  assertStaff(actor);
  const existing = await sprintsRepo.getSprint(id);
  if (!existing) throw notFound("Sprint not found");
  return db.transaction(async (tx) => {
    const sprint = await sprintsRepo.updateSprint(id, patch, tx);
    const detail = patch.status ? `${existing.status} -> ${patch.status}` : (sprint?.name ?? "");
    await pmRepo.writeActivity(activity(existing.initiativeId, actor, "sprint.updated", id, detail), tx);
    return sprint!;
  });
}

export async function deleteSprint(actor: Principal, id: number) {
  assertStaff(actor);
  const existing = await sprintsRepo.getSprint(id);
  if (!existing) throw notFound("Sprint not found");
  await db.transaction(async (tx) => {
    await pmRepo.writeActivity(activity(existing.initiativeId, actor, "sprint.deleted", id, existing.name), tx);
    await sprintsRepo.deleteSprint(id, tx);
  });
}

export async function listBacklog(actor: Principal, initiativeId: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await pmRepo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return sprintsRepo.listBacklog(initiativeId);
}

export async function listSprintTasks(actor: Principal, sprintId: number) {
  const sprint = await sprintsRepo.getSprint(sprintId);
  if (!sprint) throw notFound("Sprint not found");
  await assertClientCanSee(actor, sprint.initiativeId);
  return sprintsRepo.listSprintTasks(sprintId);
}

/** Moves a task onto a sprint (or back to the backlog with `sprintId: null`)
 * without touching its board `status` — a sprint is a planning grouping,
 * not a workflow state. */
export async function assignTaskToSprint(actor: Principal, taskId: number, sprintId: number | null) {
  assertStaff(actor);
  const task = await pmRepo.getTask(taskId);
  if (!task) throw notFound("Task not found");
  if (sprintId !== null) {
    const sprint = await sprintsRepo.getSprint(sprintId);
    if (!sprint || sprint.initiativeId !== task.initiativeId) throw notFound("Sprint not found");
  }
  await sprintsRepo.assignTaskToSprint(taskId, sprintId);
}
