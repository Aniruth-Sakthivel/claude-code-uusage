# platform

The enterprise PM platform, built to the design in
[`../docs/architecture/`](../docs/architecture/).

Greenfield, porting the parts of Meterhouse worth keeping. Single organization,
multiple workspaces. **No paid components** — see
[`adr/README.md`](../docs/architecture/adr/README.md).

## Status: Phase 0, in progress

| Item | State |
|---|---|
| Monorepo (pnpm + Turborepo) | ✅ |
| `packages/core` — RBAC, `RequestContext`, UUIDv7 | ✅ 22 tests |
| `packages/db` — tenancy schema, **scope guard** | ✅ |
| **Poison-row tenancy suite** | ✅ 17 tests, **proven to fail on a removed predicate** |
| Schema lint | ✅ 6 tests |
| `packages/contracts` | ⬜ |
| Outbox + dispatcher | ⬜ |
| WebSocket gateway + Redis pub/sub | ⬜ |
| Design-system port | ⬜ |
| `apps/api`, `apps/web`, `apps/worker` | ⬜ |
| Dockerfile, IaC, CI | ⬜ |

## Commands

```bash
pnpm install
pnpm check           # typecheck + test + tenancy suite
pnpm test:tenancy    # the tenancy gate alone
```

## The one thing to understand before changing anything

**A cross-workspace data leak is the failure mode this codebase is organized
around.** Four mechanisms, none of which is trusted alone:

1. **`RequestContext` is branded** (`packages/core/src/context.ts`) — the brand
   symbol is not exported, so no code outside that module can construct one.
   Route handlers receive a context; they cannot invent one pointing elsewhere.

2. **`scoped()` is the only way to build a WHERE clause**
   (`packages/db/src/scope.ts`). `scopeWorkspace` is unconditional — there is no
   "all workspaces" mode. `scopeProjects` is three-valued, and the case that
   matters is that an **empty grant list yields `sql\`false\``** — zero rows,
   never all rows.

3. **The schema lint** (`packages/db/src/lint/schema-lint.ts`) fails the build on
   a table with no `workspace_id` that is not in `GLOBAL_TABLES`, a composite
   index that does not lead with `workspace_id`, or a non-partial unique index
   on a soft-deletable table.

4. **The poison-row suite** (`packages/db/src/test/poison-rows.test.ts`) seeds
   two workspaces, enumerates every exported repository function **by
   reflection**, invokes each as a foreign principal, and asserts nothing leaks
   and nothing mutates. Reflection is what makes it durable: a repository
   function added next year is covered without anyone remembering.

Mechanisms 1–3 are ergonomics. **Mechanism 4 is the guarantee**, and it has been
watched fail: deleting the guard from `listProjects` produces three failures
naming the function and the leaked row id. See
`packages/db/src/test/scope-guard.test.ts`, which keeps a deliberately-unscoped
query around permanently and asserts that it *does* leak — so if anyone ever
weakens `scoped()` such that guarded and unguarded queries behave alike, that
test fails.

### Rules that keep it true

- `apps/*` may **not** import `drizzle-orm`. All SQL lives in
  `packages/db/src/repositories/**`
- Every repository function takes `ctx: RequestContext` as its first parameter
- Every repository module is re-exported from `repositories/index.ts` — the
  suite asserts barrel completeness, because a module it cannot see is a hole
  rather than a failure

## Testing without Docker

The tenancy suite runs on **PGlite** — Postgres compiled to WASM, in process.
Real Postgres semantics (partial indexes, `inArray` behaviour, NULL handling)
with no container, because Docker is not available in every environment this
must run in, and a tenancy suite that gets skipped is a tenancy suite that does
not exist.
