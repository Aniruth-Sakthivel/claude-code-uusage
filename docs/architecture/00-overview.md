# Architecture overview

An enterprise project management platform — Jira/Linear/ClickUp class — built as a
greenfield application that ports the parts of Meterhouse worth keeping.

Read this file first. Every other document in this directory assumes it.

---

## 1. What we are building

A workspace-scoped work management system: projects, issues, sprints, docs, chat,
time tracking, reporting and automation, for a single organization with many
workspaces.

| | |
|---|---|
| Tenancy | One organization, many workspaces. `workspace_id` is the scope column |
| Users | Hundreds today, tens of thousands designed-for |
| Issues | Designed for tens of millions |
| Realtime | Boards, issues and chat update live across everyone viewing them |
| Availability | 99.9% target, single region to start |

## 2. What we are starting from

Meterhouse (this repository) is ~28,800 lines of live code. It is not a blank
slate, and it is not a foundation either. The split matters:

**Worth porting**

| Asset | Path | Why |
|---|---|---|
| Theme + type system | `web/src/index.css` | Distinctive, coherent, light/dark via CSS variables. `.tnum` tabular figures are exactly right for a product full of points, hours and dates |
| UI primitives | `web/src/components/ui.tsx` | 719 lines of solid, accessible components |
| RBAC model | `api/src/core/rbac.ts` | *Capabilities gate actions, scoping gates data* — the right decomposition |
| Fail-closed scoping | `api/src/repositories/scope.ts` | 36 lines that get the hard part right: an empty scope yields **zero** rows, never all rows |
| Error envelope + request logging | `api/src/index.ts` | Stable machine-readable codes, correlation ids injected without touching handlers, driver messages never leaked |
| WebSocket security posture | `api/src/ws/server.ts` | Auth before any frame is processed, scoped broadcasts, per-connection rate limiting |
| PM table designs | `api/src/db/schema.ts` | board_columns, sprints, labels, activity-vs-audit separation |

**Why a rebuild rather than an extension**

1. **No tenancy exists.** Zero `organization_id` / `workspace_id` / `tenant_id`
   columns across all 30 tables. Retrofitting scope enforcement onto ~200
   repository functions is the one mistake in this design that cannot be
   corrected cheaply.
2. **The hosting model blocks five required workloads.** Realtime, background
   jobs, cron, file processing and long reports all die against Netlify's 26s
   function cap and `max: 1` pg pool. The WebSocket server is already written
   and *undeployable for this reason*; production silently polls over HTTP.
3. **Cross-cutting concerns are inline and unretried.** Activity, notifications,
   automation, search, webhooks and realtime are each hand-called from
   `services/pm.ts` in the request path, with no retry and no ordering.

## 3. The spine

One idea holds the system together: **a transactional domain-event outbox.**

Every service mutation writes the entity row *and* an `outbox_events` row in the
same transaction. A dispatcher then fans that single event out to six consumers:

```
service tx ──▶ outbox_events ──▶ dispatcher ──┬─▶ realtime      (Redis pub/sub → WS)
                                              ├─▶ activity feed
                                              ├─▶ notifications (+ email/push)
                                              ├─▶ automation engine
                                              ├─▶ search indexer
                                              └─▶ outbound webhooks
```

Three properties follow, and each replaces a defect in the current design:

- **Atomicity.** A side-effect can never fire for a mutation that rolled back,
  and a committed mutation can never lose its side-effect.
- **Retry.** A consumer that fails retries independently. Today a failed
  notification write takes the whole request with it.
- **Ordering and replay.** Events carry a monotonic sequence, so a reconnecting
  client can ask for what it missed instead of refetching everything.

This ships in Phase 0. Nothing else works properly without it.

## 4. Shape of the system

```
                    ┌─────────────────┐
   Browser ────────▶│ Cloudflare      │
                    │ Pages (SPA)     │
                    └─────────────────┘
        │
        │  HTTPS + WSS  (Authorization: Bearer)
        ▼
   ┌─────────────────────────────────────────────┐
   │ Cloudflare (DNS, TLS, WAF, edge rate limit) │
   └─────────────────────────────────────────────┘
        │
        ▼
   ┌──────────────────────┐        ┌──────────────────────┐
   │ API + WS  (N pods)   │◀──────▶│ Redis                │
   │ Fastify + @f/ws      │ pub/sub│ queues, presence,    │
   └──────────────────────┘        │ rate limits, cache   │
        │         ▲                 └──────────────────────┘
        │         │                          ▲
        ▼         │                          │
   ┌──────────────────────┐        ┌──────────────────────┐
   │ Postgres (Supabase)  │◀───────│ Worker (M pods)      │
   │ + outbox + FTS       │        │ BullMQ consumers     │
   └──────────────────────┘        └──────────────────────┘
                                             │
                                             ▼
                          ┌──────────────────────────────────┐
                          │ R2 (files) · Resend (email)      │
                          │ Supabase Auth · Sentry · OTel    │
                          └──────────────────────────────────┘
```

Details in [02-system.md](02-system.md) and [24-deployment.md](24-deployment.md).

## 5. Decisions taken, and where they are argued

| Decision | Choice | Document |
|---|---|---|
| Tenancy enforcement | Repository-layer guard, **not** Postgres RLS | [03-tenancy.md](03-tenancy.md) |
| Hosting | Containers, **not** serverless | [24-deployment.md](24-deployment.md) |
| Work item modelling | One `issues` table with a `type` discriminator | [10-database.md](10-database.md) |
| Board ordering | LexoRank strings, **not** integer positions | [10-database.md](10-database.md) |
| Custom fields | JSONB + a narrow filterable index, **not** EAV | [10-database.md](10-database.md) |
| Pagination | Cursor, **not** offset | [11-api.md](11-api.md) |
| Concurrency | `version` + `If-Match`, plus `Idempotency-Key` | [11-api.md](11-api.md) |
| Search | Postgres FTS, **not** a dedicated engine | [13-search.md](13-search.md) |
| Realtime | In-process WebSocket + Redis pub/sub | [12-realtime-jobs.md](12-realtime-jobs.md) |
| Client state | TanStack Query + URL state + Zustand, **no** Redux | [14-frontend.md](14-frontend.md) |

Each has an ADR in [adr/](adr/) recording the alternatives and — more usefully —
the criteria that would reverse it.

## 6. Principles

1. **Fail closed.** An empty permission scope returns nothing, never everything.
   This is a property to be *tested*, not asserted.
2. **The data layer is the security boundary.** Route handlers are not trusted
   to remember a `WHERE` clause; they cannot construct the scope object at all.
3. **One source of truth per concept.** Wire schemas live in
   `packages/contracts`; SQL lives in `packages/db/repositories`; the filter
   language has one parser shared by saved views, automation and bulk operations.
4. **Side-effects go through the outbox.** If you are calling a notification
   writer from a route handler, you are doing it wrong.
5. **Degrade, don't break.** No realtime? Fall back to polling. No search index?
   Fall back to `ILIKE`. The product stays usable.
6. **Honest numbers.** A figure whose freshness cannot be established is labelled
   stale, not displayed as current. (This principle was earned — see the
   rate-limit meter that displayed a superseded reading for 14 hours.)

## 7. Scale honestly

| | |
|---|---|
| Total build | **165–205 engineer-weeks** |
| 4 engineers, ~70% parallelism | **11–14 calendar months** to a credible alternative |
| Enterprise-buyer ready | +2–3 months |
| Defensible internal launch | Phase 0 + 1 + half of 2 ≈ **60–70 EW ≈ 4–5 months** |

Anyone quoting six months for the whole thing is quoting Phase 0 + 1 and calling
it done. Full breakdown in [26-roadmap.md](26-roadmap.md).

## 8. Reading order

**Building the foundation** → 01, 02, 03, 04, 10, 11
**Building a feature** → 05-modules/, 11, 14, 15
**Operating it** → 12, 20, 21, 24, 25
**Planning** → 26, and the risk table in it
