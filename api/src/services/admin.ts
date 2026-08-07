/**
 * Admin operations: systems, API keys, users.
 *
 * Every mutation writes an audit entry. Supabase Auth is called for credential
 * changes; the local DB only ever stores role and scoping.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { config } from "../config.js";
import { db } from "../db/client.js";
import { apiKeys, systems, users } from "../db/schema.js";
import { generateApiKey } from "../core/auth-agent.js";
import { badRequest, conflict, notFound } from "../core/errors.js";
import type { Principal, Role } from "../core/rbac.js";
import * as supabaseAdmin from "../core/supabase-admin.js";
import * as repo from "../repositories/admin.js";
import { deleteOrphanedAccounts } from "../repositories/accounts.js";

import type { DbTx } from "../db/client.js";

/**
 * Drop any Claude account the caller's delete just orphaned, and say so in the
 * audit log.
 *
 * Runs inside the caller's transaction: an account row removed while the delete
 * that orphaned it later rolls back would leave the accounts page missing a
 * subscription that still exists.
 */
async function reapOrphanedAccounts(
  actor: Principal,
  tx: DbTx,
  ctx: RequestContext,
): Promise<void> {
  const orphaned = await deleteOrphanedAccounts(tx);
  if (orphaned.length === 0) return;

  await repo.writeAudit(
    {
      actorUserId: actor.id,
      actorEmail: actor.email,
      action: "account.deleted",
      target: orphaned.join(", ").slice(0, 255),
      detail: "no machines or people left on this Claude account",
      ...ctx,
    },
    tx,
  );
}

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

// ── systems + keys ────────────────────────────────────────────────────────────
export interface CreateSystemInput {
  display_name: string;
  owner?: string;
  location?: string;
  environment?: string;
  notes?: string;
}

export async function createSystem(
  actor: Principal,
  input: CreateSystemInput,
  ctx: RequestContext = {},
) {
  const systemId = randomUUID();
  const { fullKey, prefix, keyHash } = generateApiKey();

  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(systems)
      .values({
        systemId,
        displayName: input.display_name,
        owner: input.owner ?? "",
        location: input.location ?? "",
        environment: input.environment ?? "",
        notes: input.notes ?? "",
        createdByUserId: actor.id,
      })
      .returning();

    const keyRows = await tx
      .insert(apiKeys)
      .values({ systemId, name: "default", prefix, keyHash })
      .returning();

    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "system.created",
        target: systemId,
        detail: `${input.display_name} owner=${input.owner || "-"} loc=${input.location || "-"}`,
        ...ctx,
      },
      tx,
    );

    return { system: rows[0]!, key: keyRows[0]! };
  });

  return { system: created.system, apiKey: fullKey, keyRow: created.key };
}

/**
 * Delete a system permanently.
 *
 * Keys, usage events, daily aggregates, enroll tokens, and user assignments all
 * reference `systems.systemId` with `onDelete: cascade` (see db/schema.ts), so
 * removing the row removes everything tied to it in one statement — including
 * previously-tracked usage. There is no separate "just unassign it" path; if a
 * PC is retired, this is the only way to remove it from the fleet.
 */
export async function deleteSystem(
  actor: Principal,
  systemId: string,
  ctx: RequestContext = {},
) {
  const system = await repo.getSystem(systemId);
  if (!system) throw notFound("System not found");

  await db.transaction(async (tx) => {
    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "system.deleted",
        target: systemId,
        detail: system.displayName,
        ...ctx,
      },
      tx,
    );
    await tx.delete(systems).where(eq(systems.systemId, systemId));
    // Retiring the last machine on a subscription leaves the Claude account
    // behind with nothing pointing at it, and there is no UI to remove one.
    await reapOrphanedAccounts(actor, tx, ctx);
  });
}

export interface UpdateSystemInput {
  display_name?: string;
  owner?: string;
  location?: string;
  environment?: string;
  notes?: string;
}

export async function updateSystem(
  actor: Principal,
  systemId: string,
  input: UpdateSystemInput,
  ctx: RequestContext = {},
) {
  const system = await repo.getSystem(systemId);
  if (!system) throw notFound("System not found");

  const patch: Partial<typeof systems.$inferInsert> = {};
  if (input.display_name != null) patch.displayName = input.display_name;
  if (input.owner != null) patch.owner = input.owner;
  if (input.location != null) patch.location = input.location;
  if (input.environment != null) patch.environment = input.environment;
  if (input.notes != null) patch.notes = input.notes;

  await db.transaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await tx.update(systems).set(patch).where(eq(systems.systemId, systemId));
    }
    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "system.updated",
        target: systemId,
        detail: system.displayName,
        ...ctx,
      },
      tx,
    );
  });

  return (await repo.getSystem(systemId))!;
}

export async function issueApiKey(
  actor: Principal,
  systemId: string,
  name: string,
  ctx: RequestContext = {},
) {
  if (!(await repo.systemExists(systemId))) throw notFound("System not found");

  const { fullKey, prefix, keyHash } = generateApiKey();
  const keyRow = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(apiKeys)
      .values({ systemId, name: name || "key", prefix, keyHash })
      .returning();

    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "apikey.created",
        target: systemId,
        detail: `prefix=${prefix}`,
        ...ctx,
      },
      tx,
    );
    return rows[0]!;
  });

  return { keyRow, apiKey: fullKey };
}

export async function rotateApiKey(
  actor: Principal,
  keyId: number,
  ctx: RequestContext = {},
) {
  const old = await repo.getApiKey(keyId);
  if (!old) throw notFound("API key not found");

  const { fullKey, prefix, keyHash } = generateApiKey();

  const keyRow = await db.transaction(async (tx) => {
    await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));

    const rows = await tx
      .insert(apiKeys)
      .values({ systemId: old.systemId, name: old.name, prefix, keyHash })
      .returning();

    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "apikey.rotated",
        target: old.systemId,
        detail: `old=${old.prefix} new=${prefix}`,
        ...ctx,
      },
      tx,
    );
    return rows[0]!;
  });

  return { keyRow, apiKey: fullKey };
}

export async function revokeApiKey(
  actor: Principal,
  keyId: number,
  ctx: RequestContext = {},
) {
  const key = await repo.getApiKey(keyId);
  if (!key) throw notFound("API key not found");

  await db.transaction(async (tx) => {
    await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "apikey.revoked",
        target: key.systemId,
        detail: `prefix=${key.prefix}`,
        ...ctx,
      },
      tx,
    );
  });
}

// ── users ─────────────────────────────────────────────────────────────────────
export interface CreateUserInput {
  email: string;
  full_name?: string;
  role: Role;
  system_ids?: string[];
  password?: string;
}

/**
 * Create a user.
 *
 * With no password we send a Supabase invite. The invite email carries both the
 * acceptance link and default login details (their email plus the shared
 * starter password), so the person can sign in either way — no admin reading a
 * password out to someone. With a password the account is created directly
 * (useful for scripted/offline setups).
 */
export async function createUser(
  actor: Principal,
  input: CreateUserInput,
  ctx: RequestContext = {},
  inviteRedirectTo?: string,
) {
  if (await repo.findUserByEmail(input.email)) {
    throw conflict("Email already registered");
  }
  const role = await repo.findRoleByName(input.role);
  if (!role) throw badRequest(`Unknown role '${input.role}'`);

  for (const sid of input.system_ids ?? []) {
    if (!(await repo.systemExists(sid))) throw notFound(`System not found: ${sid}`);
  }

  const invited = !input.password;
  const supabaseUserId = invited
    ? await supabaseAdmin.inviteAuthUser(input.email, input.full_name ?? "", inviteRedirectTo)
    : await supabaseAdmin.createAuthUser(input.email, input.password!, input.full_name ?? "");

  const userId = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(users)
      .values({
        email: input.email,
        fullName: input.full_name ?? "",
        supabaseUserId,
        roleId: role.id,
      })
      .returning({ id: users.id });

    const id = rows[0]!.id;
    if (input.system_ids?.length) {
      await repo.replaceUserSystems(id, input.system_ids, tx);
    }
    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: invited ? "user.invited" : "user.created",
        target: input.email,
        detail: `role=${input.role}`,
        ...ctx,
      },
      tx,
    );
    return id;
  });

  const view = await repo.getUserView(userId);
  // Echoed back so the admin can relay the credentials if the email is delayed
  // or filtered — it is the same shared starter password the invite contains.
  return {
    view: view!,
    invited,
    defaultPassword: invited ? config.INVITE_DEFAULT_PASSWORD : undefined,
  };
}

export interface UpdateUserInput {
  full_name?: string | null;
  password?: string | null;
  role?: Role | null;
  is_active?: boolean | null;
  system_ids?: string[] | null;
}

export async function updateUser(
  actor: Principal,
  userId: number,
  input: UpdateUserInput,
  ctx: RequestContext = {},
) {
  const user = await repo.getUserById(userId);
  if (!user) throw notFound("User not found");

  // Guard against an admin removing their own access and locking everyone out.
  if (user.id === actor.id && input.role && input.role !== "admin") {
    throw badRequest("You cannot change your own role away from admin.");
  }
  if (user.id === actor.id && input.is_active === false) {
    throw badRequest("You cannot deactivate your own account.");
  }

  if (input.password && user.supabaseUserId) {
    await supabaseAdmin.updateAuthUserPassword(user.supabaseUserId, input.password);
  }

  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.full_name != null) patch.fullName = input.full_name;
  if (input.is_active != null) patch.isActive = input.is_active;
  if (input.role != null) {
    const role = await repo.findRoleByName(input.role);
    if (!role) throw badRequest(`Unknown role '${input.role}'`);
    patch.roleId = role.id;
  }

  await db.transaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await tx.update(users).set(patch).where(eq(users.id, userId));
    }
    if (input.system_ids != null) {
      await repo.replaceUserSystems(userId, input.system_ids, tx);
    }
    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "user.updated",
        target: user.email,
        ...ctx,
      },
      tx,
    );
  });

  return (await repo.getUserView(userId))!;
}

export async function deleteUser(
  actor: Principal,
  userId: number,
  ctx: RequestContext = {},
) {
  const user = await repo.getUserById(userId);
  if (!user) throw notFound("User not found");
  if (user.id === actor.id) throw badRequest("You cannot delete yourself");

  if (user.supabaseUserId) {
    await supabaseAdmin.deleteAuthUser(user.supabaseUserId);
  }

  await db.transaction(async (tx) => {
    await repo.writeAudit(
      {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: "user.deleted",
        target: user.email,
        ...ctx,
      },
      tx,
    );
    await tx.delete(users).where(eq(users.id, userId));
    // `user_systems` cascades away with the row above, so this is the moment a
    // Claude account can become unreferenced.
    await reapOrphanedAccounts(actor, tx, ctx);
  });
}
