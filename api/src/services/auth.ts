/**
 * Account provisioning.
 *
 * Supabase Auth owns credentials. The local `users` row exists only to carry
 * role and system scoping. "Registration" here means creating that local row the
 * first time a Supabase identity appears.
 *
 * First-run rule: the first Supabase user ever seen becomes admin. After that,
 * accounts are created by an admin — a Supabase-authenticated user with no local
 * row has no account, and gets a clear message rather than a bare 403.
 */

import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { roles, users } from "../db/schema.js";
import { forbidden, badRequest } from "../core/errors.js";
import { CAPABILITIES, type Principal, type Role } from "../core/rbac.js";
import * as adminRepo from "../repositories/admin.js";

export async function registrationOpen(): Promise<boolean> {
  return (await adminRepo.countUsers()) === 0;
}

export interface ProvisionInput {
  supabaseUserId: string;
  email: string;
  fullName?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Ensure a local user row exists for a verified Supabase identity.
 *
 * Idempotent: an existing row is returned untouched. Also links a pre-created
 * account (admin invited someone by email) to its Supabase identity on first
 * sign-in.
 */
export async function provisionUser(input: ProvisionInput): Promise<Principal> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.supabaseUserId, input.supabaseUserId))
    .limit(1);

  if (existing[0]) {
    return toPrincipal(existing[0].id);
  }

  // An admin may have created the account by email before the person ever
  // signed in; link it to the Supabase identity now.
  const byEmail = await adminRepo.findUserByEmail(input.email);
  if (byEmail) {
    if (byEmail.supabaseUserId && byEmail.supabaseUserId !== input.supabaseUserId) {
      throw forbidden("This email is already linked to a different login.");
    }
    await db
      .update(users)
      .set({ supabaseUserId: input.supabaseUserId })
      .where(eq(users.id, byEmail.id));
    return toPrincipal(byEmail.id);
  }

  if (!(await registrationOpen())) {
    throw forbidden(
      "No account exists for this login. Ask an administrator to invite you.",
    );
  }

  // First run — this identity becomes the administrator.
  const adminRole = await adminRepo.findRoleByName("admin");
  if (!adminRole) throw badRequest("Roles are not seeded; run migrations first.");

  const inserted = await db
    .insert(users)
    .values({
      email: input.email,
      fullName: input.fullName || "Administrator",
      supabaseUserId: input.supabaseUserId,
      roleId: adminRole.id,
    })
    .returning({ id: users.id });

  const newId = inserted[0]!.id;

  await adminRepo.writeAudit({
    actorUserId: newId,
    actorEmail: input.email,
    action: "auth.register_admin",
    target: input.email,
    detail: "initial administrator",
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return toPrincipal(newId);
}

async function toPrincipal(userId: number): Promise<Principal> {
  const view = await adminRepo.getUserView(userId);
  if (!view) throw badRequest("User not found after provisioning");
  return {
    id: view.id,
    email: view.email,
    role: view.role,
    systemIds: view.systemIds,
  };
}

/** API representation of a user, including capabilities the UI can gate on. */
export function userOut(view: {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  systemIds: string[];
}) {
  return {
    id: view.id,
    email: view.email,
    full_name: view.fullName,
    role: view.role,
    is_active: view.isActive,
    system_ids: view.systemIds,
    capabilities: [...(CAPABILITIES[view.role] ?? [])],
  };
}

/** Seed the four roles. Idempotent — safe to call on every boot. */
export async function seedRoles(): Promise<void> {
  const { ROLE_DESCRIPTIONS, ROLES } = await import("../core/rbac.js");
  const existing = await db.select({ name: roles.name }).from(roles);
  const have = new Set(existing.map((r) => r.name));
  const missing = ROLES.filter((r) => !have.has(r));
  if (missing.length === 0) return;
  await db
    .insert(roles)
    .values(missing.map((name) => ({ name, description: ROLE_DESCRIPTIONS[name] })))
    .onConflictDoNothing();
}
