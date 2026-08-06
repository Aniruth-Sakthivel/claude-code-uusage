# Tenancy and data isolation

> This is the most important document in the directory. A cross-workspace data
> leak is catastrophic and reputationally unrecoverable, and it is caused by a
> single missing `WHERE` clause in any one of ~200 repository functions.

## 1. Model

**One organization, many workspaces.** `workspace_id` is the scope column on
every tenant table.

```
organizations (exactly one row today)
  └── workspaces
        ├── workspace_members  (user × workspace × role)
        ├── teams
        ├── projects
        │     ├── project_members
        │     └── issues, sprints, milestones, releases, board_columns
        ├── labels, custom_field_defs, automation_rules
        ├── docs, channels, whiteboards
        └── saved_views, webhooks, files
```

### Designed so `organization_id` can be added later

The trap is putting `organization_id` on 200 tables now "just in case". Don't.

- `organizations` exists **now**, seeded with exactly one row.
- `workspaces.organization_id` is `NOT NULL` and references it.
- **No other table carries `organization_id`.**

Scope resolution is `principal → workspace_members → workspaceId`. Adding
organizations later means adding an org predicate to *that one resolution step*,
not to every query in the system.

Two supporting decisions make a future merge or split survivable:

- **UUIDv7 primary keys** — nothing collides when datasets combine.
- **Every unique constraint is workspace-scoped**: `UNIQUE (workspace_id, slug)`,
  never `UNIQUE (slug)`. Note `labels.name` is globally unique in the current
  schema (`api/src/db/schema.ts:460`) — precisely the mistake not to repeat.

## 2. Decision: repository-layer guard, not Postgres RLS

RLS is the reflexive answer for multi-tenancy. It is the wrong one here.

**1. The authorization logic is not row-simple.** Access is:

```
capability(role) × workspace membership × project membership
                 × client-share grants × archived/deleted state
```

A `client`-role user sees only projects explicitly shared with them, and is
excluded wholesale from workspace-wide surfaces. Expressing that as SQL policies
means writing the business rules **twice** — once in TypeScript where they are
typed, tested and debuggable, once in PL/pgSQL where they are none of those
things. The two will drift, and the drift is a security bug.

**2. Connection pooling friction.** RLS needs `SET LOCAL app.workspace_id` per
request. Against a transaction-mode pooler that is only safe inside an explicit
transaction, so every read becomes a transaction. In session mode a leaked `SET`
is a cross-tenant bug with no stack trace.

**3. The existing pattern already solves the hard part.**
`api/src/repositories/scope.ts` is 36 lines and gets the critical semantic right:

```ts
if (allowed.length === 0) return sql`false`;   // zero rows, NEVER all rows
```

That fail-closed behaviour is the defect class RLS is usually adopted to prevent,
and it is already handled — in code that can be unit-tested.

**What would reverse this decision:** a requirement for direct database access by
untrusted clients (a PostgREST-style public data API), or a compliance regime
that demands isolation enforced below the application layer. Neither is on the
roadmap. Recorded in [adr/0002-tenancy-enforcement.md](adr/0002-tenancy-enforcement.md).

## 3. The guard — four mechanisms, defence in depth

No single mechanism is trusted. Each catches what the others miss.

### (a) A non-forgeable `RequestContext`

```ts
declare const brand: unique symbol;

export type RequestContext = {
  readonly [brand]: "RequestContext";     // cannot be constructed structurally
  userId: string;
  role: Role;
  workspaceId: string;
  projectScope: string[] | null;          // null = all in workspace, [] = none
  capabilities: ReadonlySet<Capability>;
};
```

Produced **only** by the auth plugin. Route code cannot fabricate one, and every
repository function takes it as its first parameter.

**The workspace slug in the URL is input, not authority.** The plugin resolves
slug → `workspace_members` row for this user, and returns **404, not 403**, when
absent — so workspace existence is not enumerable.

### (b) A `scoped()` builder that every query passes through

Extends the ported `scope.ts` to two dimensions:

```ts
scopeWorkspace(table, ctx)  // ALWAYS eq(table.workspaceId, ctx.workspaceId).
                            // No null escape hatch. Not optional.
scopeProjects(table, ctx)   // null → no filter; [] → sql`false`; else inArray
scoped(table, ctx, opts?)   // both, plus `deleted_at IS NULL` unless
                            // opts.includeDeleted is passed explicitly
```

`scopeWorkspace` deliberately has no "all workspaces" mode. Admin tooling that
genuinely needs cross-workspace reads uses a separate, explicitly-named
`unsafeCrossWorkspace()` helper that logs every call and is banned outside
`packages/db/src/admin/`.

### (c) Structural invariants enforced in CI

| Check | Failure mode it prevents |
|---|---|
| Every table in `schema/**` declares `workspace_id NOT NULL` **or** appears in an explicit `GLOBAL_TABLES` allowlist | A new table silently becomes untenanted |
| Every composite index leads with `workspace_id` | Queries that scan cross-tenant before filtering |
| ESLint bans `db.select\|insert\|update\|delete` outside `packages/db/src/repositories/**` | A route handler writing its own SQL |
| Every repository function's first parameter is `ctx: RequestContext` (AST check) | A function that forgot to accept scope |
| Every unique index on a soft-deletable table is partial `WHERE deleted_at IS NULL` | Slugs of deleted projects becoming permanently unusable |

`GLOBAL_TABLES` — `organizations`, `workspaces`, `users`, `feature_flags`,
`app_settings` — is reviewed quarterly. Adding to it requires a written
justification in the PR.

### (d) The poison-row suite — the actual guarantee

Everything above is ergonomics. This is the proof.

```
1. Seed workspace A and workspace B.
2. Insert exactly one row into EVERY tenant table under workspace B.
3. Enumerate every exported function in the repository barrel by reflection.
4. Invoke each as a workspace-A principal, with fuzzed arguments.
5. Assert: zero B rows returned. Zero B rows mutated. Zero B rows deleted.
```

Because it is **generated by reflection**, a repository function added next year
is covered without anyone remembering to write a test.

It is a blocking CI gate, and it must be proven to work: Phase 0 exit requires
deleting one `workspace_id` predicate and confirming CI goes red. *An untested
guard is not a guard.*

## 4. Permission resolution

Ported from `api/src/core/rbac.ts`, whose central insight is worth restating:
**capabilities gate actions; scoping gates data.** They are orthogonal and must
not be conflated — a manager has `view_all` (a capability) *and* an unrestricted
project scope (data), and those are two different mechanisms.

```
JWT → supabase user id
    → users row                        (401 if inactive/unknown)
    → workspace_members(user, ws)      (404 if absent — not 403)
    → role → capabilities              (static matrix, from rbac.ts)
    → project scope:
        role has view_all           → null   (all projects in workspace)
        role is client              → explicitly shared project ids (may be [])
        otherwise                   → project_members ids (may be [])
```

An empty array must yield zero rows. This is asserted directly in the unit tests
for `scopeProjects`, not merely relied upon.

Capabilities, ported and extended:

| | admin | manager | lead | contributor | viewer | client |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `view_all_projects` | ● | ● | | | ● | |
| `manage_workspace` | ● | | | | | |
| `manage_members` | ● | ● | | | | |
| `manage_projects` | ● | ● | ● | | | |
| `manage_automation` | ● | ● | | | | |
| `write_issues` | ● | ● | ● | ● | | |
| `comment` | ● | ● | ● | ● | | ● |
| `view_audit` | ● | | | | | |
| `export` | ● | ● | ● | | | |

Note `client` has exactly one capability. Everything else it might reach is
blocked by `requireStaff` at the route layer *and* by an empty project scope at
the data layer — two independent mechanisms, deliberately.

## 5. Cross-workspace surfaces

A few things legitimately span workspaces. Each is explicitly enumerated:

| Surface | Route | Scoping |
|---|---|---|
| My workspaces | `GET /api/v1/me/workspaces` | `workspace_members` for this user |
| My work | `GET /api/v1/me/issues` | Union over the user's memberships, each individually scoped |
| My notifications | `GET /api/v1/me/notifications` | `notifications.user_id = me` |
| Workspace switch | `POST /api/v1/me/workspace` | Re-resolves `RequestContext` |

These are the *only* endpoints outside `/api/v1/w/:workspaceSlug/`. Any new one
requires a documented justification, because each is an opportunity to leak.

## 6. Testing

| Level | Test |
|---|---|
| Unit | `scopeProjects([])` returns `sql\`false\``; `scopeWorkspace` cannot be bypassed |
| Generated | The poison-row suite, over every repository function |
| Integration | Workspace-A user requests every workspace-B resource by id → 404 |
| Integration | A removed member's next request → 404, and their open sockets are closed |
| E2E | Client-role user cannot reach any workspace-wide surface |
| Lint | The five structural checks in §3(c) |

## 7. Risks

| Risk | Mitigation |
|---|---|
| A repository function forgets scoping | Poison-row suite + the AST check on the first parameter |
| A new table lands untenanted | Schema lint requiring `workspace_id` or an allowlist entry |
| Raw SQL bypasses the guard | ESLint ban outside `repositories/**`; `sql` template usage reviewed |
| `unsafeCrossWorkspace` is abused | Confined to `packages/db/src/admin/`, logged on every call, reviewed quarterly |
| Permission change doesn't reach open sockets | Membership changes emit an outbox event that forces re-subscription and closes stale sockets |
| The allowlist grows silently | Quarterly review; PR template requires justification |
