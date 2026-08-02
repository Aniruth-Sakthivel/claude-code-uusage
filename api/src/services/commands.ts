/**
 * Fleet-management command dispatch.
 *
 * Enqueuing is the only thing that needs an audit trail (it's an operator
 * action against someone's machine); handing pending commands to an agent
 * on check-in and acking them are plumbing, not audited events — see
 * routes/usage.ts and ws/server.ts for those paths.
 */

import { notFound } from "../core/errors.js";
import type { Principal } from "../core/rbac.js";
import * as adminRepo from "../repositories/admin.js";
import * as commandsRepo from "../repositories/commands.js";
import { db } from "../db/client.js";
import type { RequestContext } from "./admin.js";

export async function enqueueCommand(
  actor: Principal,
  systemId: string,
  action: string,
  payload: Record<string, unknown>,
  ctx: RequestContext = {},
) {
  if (!(await adminRepo.systemExists(systemId))) throw notFound("System not found");

  return db.transaction(async (tx) => {
    const command = await commandsRepo.createCommand(systemId, action, payload, actor.id, tx);
    await adminRepo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: `command.${action}`,
        target: systemId,
        detail: JSON.stringify(payload),
        ...ctx,
      },
      tx,
    );
    return command;
  });
}

export async function listCommands(systemId: string) {
  if (!(await adminRepo.systemExists(systemId))) throw notFound("System not found");
  return commandsRepo.listForSystem(systemId);
}
