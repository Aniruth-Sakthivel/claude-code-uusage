/** Custom workflow management: per-initiative board columns. */

import { badRequest, notFound } from "../core/errors.js";
import type { Principal } from "../core/rbac.js";
import * as columnsRepo from "../repositories/boardColumns.js";
import * as pmRepo from "../repositories/pm.js";
import { assertClientCanSee, assertStaff } from "./pm.js";

export async function listColumns(actor: Principal, initiativeId: number) {
  await assertClientCanSee(actor, initiativeId);
  if (!(await pmRepo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  return columnsRepo.ensureColumns(initiativeId);
}

export async function createColumn(actor: Principal, initiativeId: number, key: string, label: string) {
  assertStaff(actor);
  if (!(await pmRepo.initiativeExists(initiativeId))) throw notFound("Initiative not found");
  if (await columnsRepo.columnKeyExists(initiativeId, key)) {
    throw badRequest(`A column with key "${key}" already exists`);
  }
  return columnsRepo.createColumn(initiativeId, key, label);
}

export async function updateColumn(actor: Principal, id: number, patch: columnsRepo.ColumnUpdateInput) {
  assertStaff(actor);
  if (!(await columnsRepo.getColumn(id))) throw notFound("Column not found");
  const column = await columnsRepo.updateColumn(id, patch);
  return column!;
}

/** Deleting a column reassigns every task on it to the fallback column
 * first — a column can never simply vanish out from under tasks that were
 * on it, leaving their `status` pointing nowhere. */
export async function deleteColumn(actor: Principal, id: number) {
  assertStaff(actor);
  const column = await columnsRepo.getColumn(id);
  if (!column) throw notFound("Column not found");

  const all = await columnsRepo.listColumns(column.initiativeId);
  if (all.length <= 1) throw badRequest("An initiative must keep at least one column");
  const fallback = all.find((c) => c.id !== id) ?? all[0]!;

  await columnsRepo.reassignTaskStatus(column.initiativeId, column.key, fallback.key);
  await columnsRepo.deleteColumn(id);
}
