/**
 * Default administrator seeder.
 *
 *   npm run db:seed-admin
 *
 * Creates exactly one admin account so a fresh deployment has a known login
 * instead of depending on whoever signs up first. Idempotent: if the account
 * already exists locally it only repairs role/link/password, and if the Supabase
 * Auth user already exists it is reused rather than duplicated.
 *
 * Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD, defaulting to the values
 * documented in the README. Change the password immediately after first sign-in.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";

import { db, closeDb } from "./client.js";
import { users } from "./schema.js";
import * as supabaseAdmin from "../core/supabase-admin.js";
import * as repo from "../repositories/admin.js";
import { seedRoles } from "../services/auth.js";

export const DEFAULT_ADMIN_EMAIL = "admin@claude-code-usage.local";
export const DEFAULT_ADMIN_PASSWORD = "Admin@2026!";
const DEFAULT_ADMIN_NAME = "Administrator";

export interface SeedAdminResult {
  email: string;
  created: boolean;
}

export async function seedDefaultAdmin(): Promise<SeedAdminResult> {
  const email = (process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).toLowerCase();
  const password = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  const fullName = process.env.ADMIN_FULL_NAME || DEFAULT_ADMIN_NAME;

  // Roles are a prerequisite for assigning one; safe to re-run.
  await seedRoles();
  const adminRole = await repo.findRoleByName("admin");
  if (!adminRole) throw new Error("Role 'admin' missing after seeding roles.");

  // Reuse an existing Auth identity when present — a repeated run must not
  // create a second Supabase user for the same email.
  let supabaseUserId = await supabaseAdmin.findAuthUserByEmail(email);
  if (supabaseUserId) {
    await supabaseAdmin.updateAuthUserPassword(supabaseUserId, password);
  } else {
    supabaseUserId = await supabaseAdmin.createAuthUser(email, password, fullName);
  }

  const existing = await repo.findUserByEmail(email);
  if (existing) {
    await db
      .update(users)
      .set({ supabaseUserId, roleId: adminRole.id, isActive: true })
      .where(eq(users.id, existing.id));
    await repo.writeAudit({
      actorUserId: existing.id,
      actorEmail: email,
      action: "auth.seed_admin",
      target: email,
      detail: "default administrator refreshed",
    });
    return { email, created: false };
  }

  const inserted = await db
    .insert(users)
    .values({ email, fullName, supabaseUserId, roleId: adminRole.id })
    .returning({ id: users.id });

  const id = inserted[0]!.id;
  await repo.writeAudit({
    actorUserId: id,
    actorEmail: email,
    action: "auth.seed_admin",
    target: email,
    detail: "default administrator created",
  });

  return { email, created: true };
}

// Run only when invoked directly, so importing this module (tests, other
// scripts) does not provision an account as a side effect. Compared as file
// URLs because Windows paths differ from `import.meta.url` textually.
const invokedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1]!)).href;

if (invokedDirectly) {
  seedDefaultAdmin()
    .then(async (r) => {
      console.log(
        r.created
          ? `Default admin created: ${r.email}`
          : `Default admin already present, refreshed: ${r.email}`,
      );
      console.log("Sign in and change the password immediately.");
      await closeDb();
    })
    .catch(async (err) => {
      console.error("\nAdmin seed failed:", err instanceof Error ? err.message : err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
