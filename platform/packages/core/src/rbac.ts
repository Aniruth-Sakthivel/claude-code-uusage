/**
 * Roles, capabilities, and the matrix between them.
 *
 * Ported from the previous system's `core/rbac.ts`, whose central insight is
 * worth restating because everything downstream depends on it:
 *
 *   **Capabilities gate actions. Scoping gates data.**
 *
 * They are orthogonal. A user may hold `write_issues` and still see nothing,
 * because their project scope is empty — and that is correct. Conflating the two
 * is how systems end up with a permission check that passes and a query that
 * returns another tenant's rows.
 *
 * Capabilities live here. Scoping lives in `@platform/db`'s scope guard, in the
 * repository layer, where a route handler cannot reach around it.
 */

export const ROLES = [
  "admin",
  "manager",
  "lead",
  "contributor",
  "viewer",
  "client",
] as const;

export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "view_all_projects",
  "manage_workspace",
  "manage_members",
  "manage_projects",
  "manage_automation",
  "write_issues",
  "comment",
  "view_audit",
  "export",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Which capabilities each role holds.
 *
 * `client` deliberately holds exactly one. Everything else an external client
 * might reach is blocked twice over: by `requireStaff` at the route layer, and
 * by an explicitly-granted project scope at the data layer. Two independent
 * mechanisms, because this is the boundary most likely to leak a whole
 * workspace to someone outside the company.
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  admin: [
    "view_all_projects",
    "manage_workspace",
    "manage_members",
    "manage_projects",
    "manage_automation",
    "write_issues",
    "comment",
    "view_audit",
    "export",
  ],
  manager: [
    "view_all_projects",
    "manage_members",
    "manage_projects",
    "manage_automation",
    "write_issues",
    "comment",
    "export",
  ],
  lead: ["manage_projects", "write_issues", "comment", "export"],
  contributor: ["write_issues", "comment"],
  viewer: ["view_all_projects"],
  client: ["comment"],
};

const MATRIX_SETS: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set(MATRIX.admin),
  manager: new Set(MATRIX.manager),
  lead: new Set(MATRIX.lead),
  contributor: new Set(MATRIX.contributor),
  viewer: new Set(MATRIX.viewer),
  client: new Set(MATRIX.client),
};

export function capabilitiesFor(role: Role): ReadonlySet<Capability> {
  return MATRIX_SETS[role];
}

export function roleHas(role: Role, capability: Capability): boolean {
  return MATRIX_SETS[role].has(capability);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Roles that see every project in the workspace without an explicit grant.
 *
 * Kept as a derived list rather than a second hand-maintained constant, so it
 * can never disagree with the matrix above.
 */
export function seesAllProjects(role: Role): boolean {
  return roleHas(role, "view_all_projects");
}

/**
 * External roles, excluded from every workspace-wide surface.
 *
 * A client who can reach workspace search, the wiki, reports or the calendar
 * sees every project in the company, because those surfaces span all of them.
 */
export function isExternal(role: Role): boolean {
  return role === "client";
}

/**
 * A role may never grant a role holding capabilities it does not itself hold.
 *
 * Without this, a manager invites an admin and escalates in one step.
 */
export function canGrantRole(actor: Role, target: Role): boolean {
  const held = MATRIX_SETS[actor];
  for (const capability of MATRIX_SETS[target]) {
    if (!held.has(capability)) return false;
  }
  return true;
}
