# Folder structure

pnpm workspaces + Turborepo. The current repo uses npm workspaces with two
members; that does not hold ten.

## 1. Layout

```
apps/
  web/                          React SPA (Vite)
    src/
      app/                      shell, router, providers, error boundaries
      features/<module>/        colocated by domain, not by file type
        api/                    typed hooks over packages/contracts
        components/
        routes/
        hooks/
        store.ts                Zustand, ephemeral UI state only
      lib/
    e2e/                        Playwright
  api/                          Fastify HTTP + WebSocket, one process
    src/
      routes/<module>.ts        thin: validate → service → serialize
      plugins/                  auth, rate-limit, otel, error-handler, cors
      ws/                       gateway, subscriptions, presence
      server.ts
  worker/                       BullMQ consumers + schedulers
    src/
      consumers/                outbox-dispatcher, search-indexer,
                                webhook-sender, email-sender, file-processor,
                                report-runner, recurrence, retention,
                                automation-runner
      schedulers/
      main.ts

packages/
  contracts/                    Zod schemas → inferred types → OpenAPI
    src/<module>.ts
  db/                           the ONLY place SQL is written
    src/
      schema/<module>.ts        drizzle tables
      repositories/<module>.ts
      scope.ts                  the tenancy guard
      admin/                    unsafeCrossWorkspace, quarantined
      migrations/
      test/poison-rows.gen.ts   generated tenancy suite
  core/                         domain services, event bus, rbac, errors,
                                ids (uuidv7), rank (LexoRank), filter-ast
  ui/                           design system, one primitive per file
    src/
      theme.css                 ported verbatim from web/src/index.css
      <Primitive>.tsx
      index.ts                  barrel
  emails/                       React Email templates
  config/                       eslint / tsconfig / tailwind / vitest presets

infra/
  Dockerfile                    one image, three entrypoints
  render.yaml                   IaC
  migrate.ts
  seed/
  compose.local.yml             postgres + redis + minio

docs/
  architecture/                 this directory
  runbook/                      on-call procedures
```

## 2. Rules

These are enforced, not suggested.

### Rule 1 — apps never import Drizzle

`apps/api` and `apps/worker` may not import `drizzle-orm`. They call
`packages/db/repositories`. Enforced by `no-restricted-imports` in the shared
ESLint config.

This is what makes the tenancy guard in [03-tenancy.md](03-tenancy.md) actually
hold. If a route handler can write its own query, every other control is
advisory.

### Rule 2 — one source of truth for wire shapes

`packages/contracts` owns every request and response schema as Zod. The API
validates with it, the web imports `z.infer` types from it, and OpenAPI is
generated from it.

This kills a real problem in the current repo: `web/src/api/types.ts` is a
hand-maintained mirror of the API's response shapes, and it drifts silently.

### Rule 3 — features are colocated

`apps/web/src/features/issues/` holds its routes, components, hooks, queries and
store. Not `components/`, `hooks/`, `pages/` split across the tree. Deleting a
feature should be deleting a directory.

Shared components graduate to `packages/ui` deliberately, by PR, not by being
imported from a sibling feature.

### Rule 4 — one primitive per file in `packages/ui`

The current `ui.tsx` is 719 lines and works fine at ~20 primitives. It will not
survive 40. Split on port, with prop signatures byte-identical so call sites do
not change.

### Rule 5 — routes are thin

A route handler validates input, calls one service function, and serializes the
result. Business logic in a route handler is a bug — it cannot be reused by the
worker, the WebSocket gateway, or a bulk operation.

## 3. Dependency direction

```
apps/web ──▶ packages/{contracts, ui, core}
apps/api ──▶ packages/{contracts, db, core, emails}
apps/worker ▶ packages/{contracts, db, core, emails}

packages/db ──▶ packages/{core, contracts}
packages/ui ──▶ (nothing internal)
packages/core ▶ packages/contracts
```

Acyclic, checked in CI. `packages/ui` importing anything internal is the usual
first violation — it must stay a pure design system with no domain knowledge.

## 4. Turborepo pipeline

| Task | Depends on | Cached |
|---|---|---|
| `build` | `^build` | ● |
| `typecheck` | `^build` | ● |
| `lint` | — | ● |
| `test` | `^build` | ● |
| `test:tenancy` | `^build` | ● |
| `e2e` | `build` | |

`pnpm turbo typecheck lint test test:tenancy` is the pre-merge gate.

## 5. What ports from where

| From | To | Change |
|---|---|---|
| `web/src/index.css` | `packages/ui/src/theme.css` | None. Verbatim |
| `web/src/components/ui.tsx` | `packages/ui/src/*.tsx` | Split per primitive; `Modal`/`ConfirmDialog` re-based on Radix, props unchanged |
| `web/src/components/charts/*` | `packages/ui/src/charts/` | None |
| `web/src/lib/{theme,format,useTableControls}.ts` | `packages/ui/src/lib/` | None |
| `api/src/core/rbac.ts` | `packages/core/src/rbac.ts` | Extend capability set; `Principal` becomes `RequestContext` |
| `api/src/repositories/scope.ts` | `packages/db/src/scope.ts` | Add the workspace dimension |
| `api/src/index.ts` error handler + hooks | `apps/api/src/plugins/` | None |
| `api/src/core/dbErrors.ts` | `packages/db/src/errors.ts` | None |
| `api/src/ws/{protocol,rateLimit}.ts` | `apps/api/src/ws/` | Add Redis pub/sub fan-out |
| `api/src/db/schema.ts` PM tables | `packages/db/src/schema/*.ts` | Restructured — see [10-database.md](10-database.md) |

The design-system split and Radix re-base happen in **Phase 0**, before any
feature code imports `packages/ui`. Doing it later means breaking call sites
mid-flight.
