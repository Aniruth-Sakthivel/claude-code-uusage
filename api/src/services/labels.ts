/** Workspace-wide label management + task attachment. */

import { notFound } from "../core/errors.js";
import type { Principal } from "../core/rbac.js";
import * as labelsRepo from "../repositories/labels.js";
import * as pmRepo from "../repositories/pm.js";
import { assertStaff } from "./pm.js";

export function listLabels() {
  return labelsRepo.listLabels();
}

export function createLabel(actor: Principal, name: string, color: string) {
  assertStaff(actor);
  return labelsRepo.createLabel(name, color);
}

export function deleteLabel(actor: Principal, id: number) {
  assertStaff(actor);
  return labelsRepo.deleteLabel(id);
}

export async function attachLabel(actor: Principal, taskId: number, labelId: number) {
  assertStaff(actor);
  if (!(await pmRepo.getTask(taskId))) throw notFound("Task not found");
  await labelsRepo.attachLabel(taskId, labelId);
}

export async function detachLabel(actor: Principal, taskId: number, labelId: number) {
  assertStaff(actor);
  await labelsRepo.detachLabel(taskId, labelId);
}
