/** Epic management — task groupings within an initiative. */

import { db } from "../db/client.js";
import { notFound } from "../core/errors.js";
import type { Principal } from "../core/rbac.js";
import * as epicsRepo from "../repositories/epics.js";
import * as pmRepo from "../repositories/pm.js";
import { assertClientCanSee, assertStaff } from "./pm.js";

function activity(initiativeId: number, actor: Principal, action: string, entityId: number, detail: string) {
  return { initiativeId, actorUserId: actor.id, actorEmail: actor.email, action, entityType: "epic", entityId, detail };
}

export async function createEpic(actor: Principal, initiativeId: number, input: epicsRepo.EpicCreateInput) {
  assertStaff(actor);
  if (!(await pmRepo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return db.transaction(async (tx) => {
    const epic = await epicsRepo.createEpic(initiativeId, input, actor.id, tx);
    await pmRepo.writeActivity(activity(initiativeId, actor, "epic.created", epic.id, epic.name), tx);
    return epic;
  });
}

export async function listEpics(actor: Principal, initiativeId: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await pmRepo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return epicsRepo.listEpics(initiativeId);
}

export async function updateEpic(actor: Principal, id: number, patch: epicsRepo.EpicUpdateInput) {
  assertStaff(actor);
  const existing = await epicsRepo.getEpic(id);
  if (!existing) throw notFound("Epic not found");
  return db.transaction(async (tx) => {
    const epic = await epicsRepo.updateEpic(id, patch, tx);
    await pmRepo.writeActivity(
      activity(existing.initiativeId, actor, "epic.updated", id, epic?.name ?? ""),
      tx,
    );
    return epic!;
  });
}

export async function deleteEpic(actor: Principal, id: number) {
  assertStaff(actor);
  const existing = await epicsRepo.getEpic(id);
  if (!existing) throw notFound("Epic not found");
  await db.transaction(async (tx) => {
    await pmRepo.writeActivity(
      activity(existing.initiativeId, actor, "epic.deleted", id, existing.name),
      tx,
    );
    await epicsRepo.deleteEpic(id, tx);
  });
}
