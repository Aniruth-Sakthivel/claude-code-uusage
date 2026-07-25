/**
 * Human authentication — Supabase-issued JWTs.
 *
 * Supabase signs sessions with ES256 (asymmetric), so the server verifies them
 * against Supabase's public JWKS endpoint. There is no shared secret to leak or
 * rotate. Agent API keys (see auth-agent.ts) are an entirely separate credential
 * and are never accepted here.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";

import { config } from "../config.js";
import { db } from "../db/client.js";
import { roles, users, userSystems } from "../db/schema.js";
import { unauthorized } from "./errors.js";
import { isRole, type Principal, type Role } from "./rbac.js";

// Module scope: the key set is fetched once and cached across warm invocations.
const jwks = createRemoteJWKSet(new URL(config.supabaseJwksUrl), {
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
});

export interface SupabaseClaims {
  sub: string;
  email?: string;
  user_metadata?: { full_name?: string };
}

/** Verify a Supabase access token. Throws `unauthorized` on any failure. */
export async function verifySupabaseToken(token: string): Promise<SupabaseClaims> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: "authenticated",
      clockTolerance: 10,
    });
    if (!payload.sub) throw new Error("token has no subject");
    return payload as unknown as SupabaseClaims;
  } catch {
    throw unauthorized();
  }
}

/**
 * Resolve the local application user for a verified Supabase identity.
 *
 * Supabase owns credentials; the local row carries role + system assignments
 * (RBAC). A Supabase-authenticated user with no local row has no account yet —
 * that is a 401, and the provisioning endpoint decides whether to create one.
 */
export async function loadPrincipal(supabaseUserId: string): Promise<Principal> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      isActive: users.isActive,
      roleName: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.supabaseUserId, supabaseUserId))
    .limit(1);

  const row = rows[0];
  if (!row || !row.isActive) throw unauthorized();
  if (!isRole(row.roleName)) throw unauthorized();

  const assigned = await db
    .select({ systemId: userSystems.systemId })
    .from(userSystems)
    .where(eq(userSystems.userId, row.id));

  return {
    id: row.id,
    email: row.email,
    role: row.roleName as Role,
    systemIds: assigned.map((a) => a.systemId),
  };
}

export function bearerToken(authorization: string | undefined): string {
  if (!authorization?.toLowerCase().startsWith("bearer ")) throw unauthorized();
  const token = authorization.slice(7).trim();
  if (!token) throw unauthorized();
  return token;
}
