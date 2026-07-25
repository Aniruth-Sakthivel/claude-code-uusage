/**
 * Server-side data scoping — the single place authorization is enforced.
 *
 * Every repository query that returns usage data runs through `scopeSystems`.
 * The contract:
 *
 *   allowed === null   → no filter (admin / manager / viewer see everything)
 *   allowed.length > 0 → restrict to those system ids
 *   allowed.length === 0 → match NOTHING
 *
 * That last case is the one that matters. A developer with no assigned systems
 * must see zero rows; returning "no filter" for an empty set would silently
 * expose the whole fleet. Fail closed, never open.
 */

import { inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export type Allowed = string[] | null;

export function scopeSystems(column: PgColumn, allowed: Allowed): SQL | undefined {
  if (allowed === null) return undefined; // unrestricted
  if (allowed.length === 0) return sql`false`; // fail closed — zero rows
  return inArray(column, allowed);
}

/** True when the caller provably cannot see anything (skip the query entirely). */
export function isEmptyScope(allowed: Allowed): boolean {
  return allowed !== null && allowed.length === 0;
}

/** True when this caller may read the given system. */
export function allowsSystem(allowed: Allowed, systemId: string): boolean {
  if (allowed === null) return true;
  return allowed.includes(systemId);
}
