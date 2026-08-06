# Roadmap

Effort in **engineer-weeks (EW)**, assuming senior engineers who know this stack.

## 1. Phases

| Phase | Scope | EW | Depends on |
|---|---|---|---|
| **0 — Foundations** | Monorepo + Turborepo, Dockerfile, `render.yaml`, CI. `packages/contracts`. `packages/db` schema + migrations + **scope guard + poison-row suite**. Auth → `RequestContext`, workspaces + members + invites. Outbox + dispatcher + one consumer end to end. WS gateway + Redis pub/sub. Design-system port + Radix re-base + Tabs/Stat/Avatar. App shell, router, error boundaries. Sentry + OTel. Runbook. Feature flags | **18–22** | — |
| **1 — Core work management** | Projects, board columns, `issues` (all types), rank/DnD, DataGrid list view, filter AST + saved views, labels, comments + mentions, watchers, attachments (R2 + file worker), activity feed, notifications + bell, realtime on board and issue, search v1, My Work | **32–40** | 0 |
| **2 — Planning** | Sprints + backlog + estimation, milestones, epic rollups, releases, dependencies, **Gantt/timeline (built in-house, staged)**, roadmap view, capacity, teams | **29–37** | 1 |
| **3 — Time & reporting** | Time tracking, timesheets + approvals, dashboards + widgets, burndown/velocity/CFD/cycle-time, async exports, scheduled reports, digests | **20–26** | 1, 2 |
| **4 — Collaboration** | Docs/wiki + versions + diff/restore, chat (channels, DMs, reads, reactions), whiteboard, meetings + calendar sync, editor hardening | **22–28** | 1 |
| **5 — Extensibility & admin** | Custom fields + filterable index, issue templates, recurring issues, automation v2 on the filter AST, webhooks + delivery UI, public REST API + PATs + OpenAPI portal, imports, directory | **26–32** | 1 (needs the filter AST) |
| **6 — Enterprise hardening** | **OIDC SSO + SCIM + SAML, all built in-house**, MFA policies, session & device management, audit export + retention, rate tiers, load testing, WCAG 2.1 AA audit, pen test, DR drill | **28–35** | all |

**Total ≈ 175–220 EW.**

Phases 2 and 6 grew from the original estimate because **there is no budget for
licensed components or paid service tiers**, so two things that were priced as
configuration are now builds:

| Change | Was | Now | ADR |
|---|---|---|---|
| Gantt | 3-week timebox with a commercial fallback | 5–6 EW staged build, no fallback | [0012](adr/0012-build-gantt-in-house.md) |
| SAML SSO + SCIM | ~1 EW of Supabase configuration | 10–12 EW in-house (OIDC → SCIM → SAML) | [0011](adr/0011-build-sso-in-house.md) |

## 2. Calendar time, honestly

Effective throughput is `engineers × parallelism` EW per calendar week. Total
÷ throughput ÷ 4.33 = months.

| Team size | Parallelism | EW/week | To a credible Jira/Linear alternative |
|---|---|---|---|
| 2 engineers | ~90% | 1.8 | **22–28 months** |
| **4 engineers** | **~70%** | **2.8** | **14–18 months** |
| 6 engineers | ~55% | 3.3 | 12–15 months |
| 8 engineers | ~45% | 3.6 | 11–14 months |

Parallelism falls as team size rises — Phase 0 barely parallelizes at all, and
coordination cost is real. Adding people to Phase 0 makes it slower, not faster.

Add **2–3 months** beyond any of these for enterprise-buyer readiness (pen test,
accessibility audit, SOC 2 groundwork) beyond the Phase 6 engineering itself.

**Anyone quoting six months for the whole thing is quoting Phase 0 + 1 and
calling it done.**

## 3. The recommended cut

**Phase 0 + Phase 1 + the sprints/backlog half of Phase 2 ≈ 65–80 EW ≈ 5–7
months with four engineers.**

Deliberately excludes Gantt: the sprints-and-backlog half of Phase 2 is the half
that makes the product usable, and Gantt is the half that carries the schedule
risk.

That is a genuinely usable product: workspaces, projects, issues with custom
workflows, board and list views, comments, attachments, notifications, realtime,
search, sprints and a backlog.

Launch there internally, then let real usage order Phases 3–5. The alternative —
building all seven phases before anyone uses it — guarantees building the wrong
half of Phase 5.

## 4. Sequencing constraints

Non-negotiable:

1. **The scope guard and its poison-row suite ship in Phase 0**, before the first
   tenant table holds data. Retrofitting tenancy onto ~200 repository functions is
   the one mistake in this design that cannot be corrected cheaply.
2. **The design-system split and Radix re-base happen in Phase 0**, before any
   feature code imports `packages/ui`. Later means breaking call sites mid-flight.
3. **The outbox ships in Phase 0** with at least one consumer proven end to end.
   Every later module assumes it.
4. **The filter AST ships in Phase 1.** Saved views, automation and bulk
   operations all consume it; building them against three different filter
   implementations is how they drift.
5. **Playwright is established in Phase 0** with five journeys. Retrofitting E2E
   onto a large UI is far more expensive than growing it alongside.
6. **Feature flags ship in Phase 0**, because they are the primary rollback
   mechanism for everything after it.

## 5. Phase 0 exit criteria

All must pass before Phase 1 begins:

1. `pnpm turbo typecheck lint test` green across every package
2. **The poison-row suite passes and is proven to fail** — delete one
   `workspace_id` predicate, confirm CI goes red
3. A user creates a workspace, invites a second user, both see it — over real
   HTTP against a deployed container, not a local mock
4. A mutation writes an `outbox_events` row in the same transaction, the
   dispatcher fans it out, and a second browser receives the WebSocket event and
   updates without refetching
5. Kill the WebSocket: the client falls back to polling within 3 reconnect
   attempts and stays correct
6. Playwright's 5 seed journeys pass headless in CI
7. A migration runs forward and back cleanly against a restored
   production-shaped dump
8. Sentry captures a deliberate backend error and a frontend render error, each
   with the correct `requestId`
9. The runbook exists and names an on-call owner

## 6. Top 10 risks

| # | Risk | Why it is real here | Mitigation |
|---|---|---|---|
| 1 | **Cross-workspace data leak** | 200+ repository functions, any one can omit a predicate. Catastrophic and reputationally unrecoverable | The four mechanisms in [03-tenancy.md](03-tenancy.md). Specifically the generated poison-row suite as a blocking gate, the schema lint, and the ESLint ban on raw `db.*` |
| 2 | **Scope creep to "Jira parity"** | The gap list has 30 items and no bottom. Every one sounds small | A written, versioned cut list per phase with explicit *not in v1* entries. Phase gates require a demo. New requests cannot enter an in-flight phase |
| 3 | **Gantt becomes a sinkhole, with no purchase fallback** | Genuinely 4–8 weeks, every estimate underestimates it, and there is no licence budget — so the usual escape hatch does not exist | Staged scope where **Stage 1 (read-only) is independently useful** and Stages 3–5 are deferrable. Budgeted at 5–6 EW rather than a timebox protecting nothing. Reverse-check if Stage 1 alone exceeds 3 EW ([adr/0012](adr/0012-build-gantt-in-house.md)) |
| 3b | **We own a security-critical SAML implementation** | SAML has a long history of severe vulnerabilities: signature wrapping, XML canonicalization, `NameID` comment truncation. A bug here is an authentication bypass | OIDC first so SAML is built only when a deal requires it. Signature/XML path line-by-line reviewed. Mandatory replay cache. Library advisories page immediately. Named target in the pen test ([adr/0011](adr/0011-build-sso-in-house.md)) |
| 4 | **Realtime consistency bugs** | Optimistic update + WS echo + concurrent editor is the classic source of "my change disappeared". Unreproducible from a bug report | Monotonic `version` + `If-Match` + drop-stale-version on the client. Deterministic tests over synthetic out-of-order streams. Mandatory polling fallback |
| 5 | **Board ranking corruption** | 30 people dragging one board; integer positions lose updates and duplicate | LexoRank + single-row updates + `If-Match`. Nightly rebalance. Property test over 10,000 concurrent moves |
| 6 | **Custom fields destroy query performance** | Unbounded JSONB filter/sort table-scans at 500k issues | Hard cap on filterable fields, trigger-maintained index table, `EXPLAIN` assertions in CI, 400 rather than a slow 200 |
| 7 | **Zero frontend tests → regression cliff** | The current repo has none; the new UI is 10× larger with DnD, virtualization and realtime | Playwright from Phase 0, coverage floors in CI, Storybook + Chromatic |
| 8 | **Ops burden of leaving serverless** | Zero-ops Netlify → 4 services, Redis, queues, DLQs and on-call, owned by nobody today | One Dockerfile, IaC in git, Bull Board + Sentry + probes from day one, runbook in Phase 0, named on-call owner before Phase 1 |
| 9 | **Design-system churn** | Splitting a 719-line file and re-basing on Radix breaks call sites if done late | Both in Phase 0, before any feature imports `packages/ui`. Prop signatures preserved. One PR |
| 10 | **Data model churn once real users arrive** | You will be wrong about issue types, workflow states and permissions | Strict expand-contract migrations. Never `DROP COLUMN` in the release that stops writing it. Feature flags so half-built models ship dark. Quarterly restore drill |

The build-versus-buy question that used to sit here is now closed: **there is no
budget, so everything is built.** Both ADRs record what buying would have bought,
so the decision is cheap to revisit if that changes.

## 7. What would change the plan

Written down so a change of direction is a decision rather than a drift:

| If | Then |
|---|---|
| Multi-organization becomes a requirement | Add ~6 EW in Phase 0. Far more later — this is the cheapest moment |
| Real-time collaborative doc editing is required | Add a CRDT track, ~12 EW, and revisit the docs module design |
| Mobile apps are required | A separate track; the API is ready, the UI is not |
| Search trip-wires fire | ~4 EW to swap in Typesense — but solve the ACL problem before migrating, not during |
| Budget appears for a commercial Gantt | −4 EW in Phase 2. The component sits behind a stable prop interface, so swapping it is contained |
| Budget appears for an identity broker (WorkOS, Auth0, Stytch) | −8 EW in Phase 6. SSO is behind one adapter, so principal resolution is untouched |
| A deal closes on OIDC alone | SAML defers indefinitely: −4–5 EW from Phase 6 |
| The team is 2 rather than 4 | Ship the recommended cut only; defer Phases 3–6 indefinitely and say so |
