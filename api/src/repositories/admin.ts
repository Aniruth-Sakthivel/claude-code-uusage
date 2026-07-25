/**
 * Admin data access: users, roles, API keys, audit log.
 *
 * These are capability-gated at the route layer (`manage_users`, `manage_keys`,
 * `view_audit`) rather than system-scoped, because they operate on fleet-wide
 * entities rather than usage data.
 */

import { and, desc, eq, sql } from "drizzle-orm";

import { db, type DbLike } from "../db/client.js";
import {
  apiKeys,
  auditLogs,
  roles,
  systems,
  users,
  userSystems,
} from "../db/schema.js";
import type { Role } from "../core/rbac.js";

// ── roles ─────────────────────────────────────────────────────────────────────
export async function findRoleByName(name: string, conn: DbLike = db) {
  const rows = await conn.select().from(roles).where(eq(roles.name, name)).limit(1);
  return rows[0] ?? null;
}

// ── users ─────────────────────────────────────────────────────────────────────
export interface UserView {
  id: number;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  systemIds: string[];
}

export async function listUsers(): Promise<UserView[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      isActive: users.isActive,
      role: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .orderBy(users.email);

  if (rows.length === 0) return [];

  const assignments = await db
    .select({ userId: userSystems.userId, systemId: userSystems.systemId })
    .from(userSystems);

  const bySystem = new Map<number, string[]>();
  for (const a of assignments) {
    const list = bySystem.get(a.userId) ?? [];
    list.push(a.systemId);
    bySystem.set(a.userId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.fullName,
    role: r.role as Role,
    isActive: r.isActive,
    systemIds: bySystem.get(r.id) ?? [],
  }));
}

export async function getUserView(userId: number): Promise<UserView | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      isActive: users.isActive,
      role: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const assigned = await db
    .select({ systemId: userSystems.systemId })
    .from(userSystems)
    .where(eq(userSystems.userId, userId));

  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role as Role,
    isActive: row.isActive,
    systemIds: assigned.map((a) => a.systemId),
  };
}

export async function findUserByEmail(email: string, conn: DbLike = db) {
  const rows = await conn.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function getUserById(userId: number, conn: DbLike = db) {
  const rows = await conn.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function countUsers(conn: DbLike = db): Promise<number> {
  const rows = await conn.select({ n: sql<number>`count(*)::int` }).from(users);
  return Number(rows[0]?.n ?? 0);
}

export async function replaceUserSystems(
  userId: number,
  systemIds: string[],
  conn: DbLike = db,
): Promise<void> {
  await conn.delete(userSystems).where(eq(userSystems.userId, userId));
  if (systemIds.length > 0) {
    await conn.insert(userSystems).values(systemIds.map((systemId) => ({ userId, systemId })));
  }
}

export async function systemExists(systemId: string, conn: DbLike = db): Promise<boolean> {
  const rows = await conn
    .select({ id: systems.systemId })
    .from(systems)
    .where(eq(systems.systemId, systemId))
    .limit(1);
  return rows.length > 0;
}

// ── api keys ──────────────────────────────────────────────────────────────────
export async function listApiKeys(systemId: string) {
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.systemId, systemId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function getApiKey(keyId: number, conn: DbLike = db) {
  const rows = await conn.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  return rows[0] ?? null;
}

export async function listActiveKeysForSystems(systemIds: string[]) {
  if (systemIds.length === 0) return [];
  return db
    .select()
    .from(apiKeys)
    .where(and(sql`${apiKeys.systemId} = any(${systemIds})`, sql`${apiKeys.revokedAt} is null`))
    .orderBy(desc(apiKeys.createdAt));
}

// ── audit ─────────────────────────────────────────────────────────────────────
export async function listAudit(limit = 200) {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.at)).limit(limit);
}

export interface AuditInput {
  actorUserId?: number | null;
  actorEmail?: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
  userAgent?: string;
}

/** Append an audit entry. Never records secrets, prompts, responses, or code. */
export async function writeAudit(entry: AuditInput, conn: DbLike = db): Promise<void> {
  await conn.insert(auditLogs).values({
    actorUserId: entry.actorUserId ?? null,
    actorEmail: entry.actorEmail ?? "system",
    action: entry.action,
    target: entry.target ?? "",
    detail: entry.detail ?? "",
    ip: entry.ip ?? "",
    userAgent: (entry.userAgent ?? "").slice(0, 255),
  });
}
