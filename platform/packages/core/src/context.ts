/**
 * The request context — the object the entire tenancy guard rests on.
 *
 * It is *branded*: the symbol below is not exported, so no code outside this
 * module can produce a value that satisfies the type structurally. Route
 * handlers receive one; they cannot invent one, cannot widen one, and cannot
 * construct a "just this once" context pointing at another workspace.
 *
 * That is the whole point. Every repository function takes `ctx` as its first
 * parameter, and the only way to obtain a `ctx` is to have been authenticated.
 */

import { capabilitiesFor, isExternal, seesAllProjects, type Capability, type Role } from "./rbac.js";

declare const brand: unique symbol;

export interface RequestContext {
  readonly [brand]: "RequestContext";
  readonly userId: string;
  readonly role: Role;
  readonly workspaceId: string;
  /**
   * Projects this principal may read.
   *
   * `null`  → every project in the workspace (a `view_all_projects` role)
   * `[]`    → **none**. Must yield zero rows, never all rows
   * `[...]` → exactly these
   *
   * The empty-array case is the one that matters. A guard that treats "no
   * scope" as "no filter" turns a permission failure into a full data dump,
   * and it is the single most common way this class of bug ships.
   */
  readonly projectScope: readonly string[] | null;
  readonly capabilities: ReadonlySet<Capability>;
}

export interface PrincipalInput {
  userId: string;
  role: Role;
  workspaceId: string;
  /** Explicit project grants. Ignored when the role sees all projects. */
  projectIds: readonly string[];
}

/**
 * Build a context. Called by the auth plugin, and by tests. Nowhere else.
 *
 * Deliberately not exported from the package barrel under a friendly name —
 * see `index.ts`, which re-exports it as `__unsafeCreateRequestContext` so that
 * a call site reads as the exception it is.
 */
export function createRequestContext(input: PrincipalInput): RequestContext {
  const projectScope = seesAllProjects(input.role) ? null : [...input.projectIds];

  return {
    userId: input.userId,
    role: input.role,
    workspaceId: input.workspaceId,
    projectScope,
    capabilities: capabilitiesFor(input.role),
  } as RequestContext;
}

export function hasCapability(ctx: RequestContext, capability: Capability): boolean {
  return ctx.capabilities.has(capability);
}

/** External principals are excluded from every workspace-wide surface. */
export function isExternalContext(ctx: RequestContext): boolean {
  return isExternal(ctx.role);
}

/**
 * True when this context can see nothing at all.
 *
 * Useful for short-circuiting before a query, but **never** as a substitute for
 * the scope guard — the guard must be correct on its own, because a caller who
 * forgets this check must still get zero rows.
 */
export function hasEmptyScope(ctx: RequestContext): boolean {
  return ctx.projectScope !== null && ctx.projectScope.length === 0;
}
