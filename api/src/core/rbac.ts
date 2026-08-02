/**
 * Role-based access control.
 *
 * Two distinct concepts, deliberately separate:
 *   - **Capabilities** gate *actions* (managing users, keys, viewing audit).
 *   - **Scoping** gates *data* — which systems a user may see.
 *
 * The critical guarantee is `visibleSystemIds`: it returns the set of systems a
 * caller may read, and every repository query filters by it. A developer cannot
 * reach an unassigned PC even by hand-crafting the request, because the filter
 * lives in the data layer, not the route.
 */

export const ADMIN = "admin";
export const MANAGER = "manager";
export const DEVELOPER = "developer";
export const VIEWER = "viewer";
// External, not internal staff — see repositories/pm.ts `initiativeClients`
// and services/pm.ts's role check. Zero fleet capabilities and zero access
// to the open-to-everyone PM posture other roles get: a client only ever
// sees the specific initiatives explicitly shared with them, read-only plus
// commenting, never chat/wiki/reports/automations/whiteboard/other
// initiatives. Provisioned through the same admin invite flow as every
// other role — no separate auth system.
export const CLIENT = "client";

export const ROLES = [ADMIN, MANAGER, DEVELOPER, VIEWER, CLIENT] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [ADMIN]: "Full access: manage users, roles, systems, API keys, view audit logs.",
  [MANAGER]: "View all systems, analytics, and reports; no user/key management.",
  [DEVELOPER]: "View only assigned systems and their usage.",
  [VIEWER]: "Read-only access to all systems.",
  [CLIENT]: "External client portal: read-only access to initiatives shared with them, plus commenting.",
};

export type Capability =
  | "view_all"
  | "manage_users"
  | "manage_keys"
  | "manage_systems"
  | "view_audit"
  | "export"
  | "connect_own_pc";

/**
 * Capability matrix.
 *
 * `connect_own_pc` is new: every role gets it, including developers. Previously
 * only admins could create a system, which left non-admin users on an empty
 * dashboard with no way to connect their own machine.
 */
export const CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  [ADMIN]: new Set([
    "view_all",
    "manage_users",
    "manage_keys",
    "manage_systems",
    "view_audit",
    "export",
    "connect_own_pc",
  ]),
  [MANAGER]: new Set(["view_all", "export", "connect_own_pc"]),
  [DEVELOPER]: new Set(["connect_own_pc"]),
  [VIEWER]: new Set(["view_all", "connect_own_pc"]),
  [CLIENT]: new Set([]),
};

export interface Principal {
  id: number;
  email: string;
  role: Role;
  /** Systems explicitly assigned to this user (only meaningful for developers). */
  systemIds: string[];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(user: Principal, capability: Capability): boolean {
  return CAPABILITIES[user.role]?.has(capability) ?? false;
}

/**
 * Systems this user may see.
 *
 * `null` means "no filter — all systems". A concrete array (including an EMPTY
 * one) means "only these". The empty case must yield zero rows, never all rows;
 * see `scopeSystems` in the repository layer.
 */
export function visibleSystemIds(user: Principal): string[] | null {
  if (user.role === ADMIN || user.role === MANAGER || user.role === VIEWER) {
    return null;
  }
  return user.systemIds; // developer: assigned only
}
