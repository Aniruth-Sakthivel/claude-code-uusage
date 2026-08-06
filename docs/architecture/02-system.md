# System architecture

## 1. Objective

A runtime that can hold open WebSocket connections, run background work, process
files and generate long reports — none of which the current serverless model
permits.

## 2. Why the hosting model changes

Netlify functions block five of the named workloads outright. This is not a
preference:

| Workload | Under Netlify functions | Verdict |
|---|---|---|
| WebSocket realtime | No persistent process. `api/src/ws/server.ts` is 502 written lines that cannot be deployed *for this reason* | Blocker |
| Background jobs | No worker runtime, no long-lived consumer | Blocker |
| Cron | Scheduled Functions share the 26s cap, with no concurrency control or retry semantics | Blocker |
| File processing | 26s cap, no shared temp, cold start per file | Blocker |
| Search indexing | Needs a durable consumer | Blocker |
| Long reports and exports | 26s cap, hard-coded in `netlify.toml` | Blocker |
| DB connections | `max: 1` in production purely to survive the model; no pipelining | Severe tax |

The cost is already being paid: the WebSocket server exists, is well written, and
production polls over HTTP instead. That is not viable for a board shared by
thirty people.

## 3. Runtime topology

Three deployables from **one Docker image**, differing only in entrypoint:

| Service | Entrypoint | Scale | Responsibility |
|---|---|---|---|
| `api` | `apps/api` | 2+ pods, autoscale on CPU | HTTP + WebSocket in one process |
| `worker` | `apps/worker` | 1+ pods, scale on queue depth | BullMQ consumers, schedulers |
| `migrate` | `infra/migrate.ts` | Run-once, pre-deploy | Schema migrations |

One image means one build, one dependency tree, one set of repository code, and a
one-day migration to Fly/Railway/ECS if the provider disappoints.

**WebSocket lives inside the API process.** The current split into a separate
`ws-server` with its own pg pool (`api/src/ws/db.ts`) existed only because
Netlify forced it. Merging them gives one deployable, one auth path, one pool,
and one place where scoping is enforced.

## 4. Components

| Concern | Choice | Rationale |
|---|---|---|
| API + WS | Render Web Service (Docker) | Persistent process, native WS, private networking, `render.yaml` as IaC |
| Workers | Render Background Worker | Same image, independent scaling |
| Cron | Render Cron → enqueue; BullMQ repeatable jobs fan out per workspace | Cron triggers "enqueue digests for all workspaces"; BullMQ does the N jobs with retries |
| Postgres | Supabase, session/direct pooler, `pool.max: 10–20` | No longer serverless, so drop the `max:1` hack. Keeps Auth colocated and the Drizzle tooling intact |
| Auth | Supabase Auth (free tier) | Already integrated (ES256 + remote JWKS via `jose`). Supplies password, magic link, OAuth and MFA at no cost. **SAML and SCIM are built in-house** — no budget for a paid tier ([adr/0011](adr/0011-build-sso-in-house.md)) |
| Redis | Managed, private network | BullMQ, realtime pub/sub, rate-limit buckets, hot cache. Not Upstash: BullMQ is chatty and per-command pricing punishes it |
| Object storage | Cloudflare R2 | S3 API, presigned PUT/GET, **zero egress** — which matters when every issue has attachments |
| Edge | Cloudflare | DNS, TLS, WAF, edge rate limiting, DDoS |
| SPA | Cloudflare Pages | Static assets have no business inside the container |
| Email | Resend + React Email | Templates live in `packages/emails`, previewable in Storybook. Template *tables* in the database are a trap |
| Errors | Sentry (both ends) | |
| Traces/metrics | OpenTelemetry → Axiom or Grafana Cloud | |
| CI | GitHub Actions | typecheck, lint, unit, **tenancy-leak suite**, Playwright, migration dry-run, image build |

### The CORS consequence

Splitting the SPA onto its own origin loses the same-origin property the current
`netlify.toml` enjoys. Accept it deliberately:

- API on `api.example.com`, app on `app.example.com`
- Explicit CORS allowlist, credentials off
- **Auth token in the `Authorization` header, never in a cookie** — which makes
  CSRF structurally impossible rather than mitigated

## 5. Request paths

**Read**

```
Browser → Cloudflare → api pod → auth plugin (JWT → RequestContext)
                               → route handler (validates with Zod)
                               → repository (applies scope guard)
                               → Postgres
```

The auth plugin is the only thing that can construct a `RequestContext`, and the
repository is the only thing that can reach Drizzle. Between them, a route
handler physically cannot query outside its workspace.

**Write**

```
… → service.mutate()
      ├─ tx: UPDATE entity SET …, version = version + 1
      └─ tx: INSERT outbox_events (…)
    COMMIT
      → dispatcher picks it up (FOR UPDATE SKIP LOCKED)
          ├─ Redis publish → every api pod → matching sockets
          ├─ activity row
          ├─ notifications (+ email job)
          ├─ automation evaluation
          ├─ search index upsert
          └─ webhook delivery jobs
```

The handler returns as soon as the transaction commits. Nothing in that fan-out
is on the response path.

**Realtime**

```
Browser --WSS--> api pod N
   subscribe {scope}  → validated against RequestContext, then again on any
                        permission-change event
   ← event {type, workspaceId, entityType, entityId, version, patch, actorId, ts}
```

Cross-pod delivery is Redis pub/sub on `ws:{workspaceId}:{scope}`. Without it, a
change on pod 1 never reaches a socket on pod 3.

## 6. Environments

| Environment | Purpose | Data |
|---|---|---|
| `local` | Docker Compose: Postgres, Redis, MinIO (R2-compatible) | Seeded fixtures |
| `preview` | Per-PR ephemeral, auto-destroyed | Seeded fixtures |
| `staging` | Pre-production, same shape as prod | Anonymized production dump |
| `production` | | |

Migrations run as a pre-deploy step and must be backward-compatible with the
currently-running image — see the expand-contract rule in
[24-deployment.md](24-deployment.md).

## 7. Failure modes and degradation

Each is a designed behaviour, not an accident:

| Failure | Behaviour |
|---|---|
| Redis down | Realtime stops; **clients fall back to polling**. Queues stall but the outbox retains every event and drains on recovery. Rate limiting fails open with a logged warning |
| Worker down | Nothing is lost. `outbox_events` accumulates; a depth alert fires at 10,000 |
| Search index stale | Search degrades to `ILIKE` on titles with a "results may be incomplete" banner |
| R2 unavailable | Uploads fail with a clear error. Existing attachments 404 with a retry affordance. Nothing else is affected |
| Postgres failover | API returns 503 from `/ready`; the load balancer drains; the SPA shows a maintenance state rather than a stack of failed requests |
| One pod wedged | `/ready` fails, pod is replaced. Port the health/ready split from `api/src/index.ts` — `/live` must never touch the database |

The principle: **degrade, don't break.** Today's production behaviour (HTTP
polling) becomes the fallback path rather than the only path.

## 8. Security boundaries

| Boundary | Control |
|---|---|
| Internet → edge | Cloudflare WAF, DDoS, per-IP rate limit |
| Edge → API | TLS, CORS allowlist, Bearer token |
| API → data | `RequestContext` + repository scope guard ([03-tenancy.md](03-tenancy.md)) |
| API → Redis/Postgres/R2 | Private network, no public ingress |
| Worker → external | Egress allowlist for webhook destinations (SSRF defence) |
| Agent/service → API | Hashed API keys and PATs, never stored in plaintext |

Detail in [20-security.md](20-security.md).

## 9. Cost

| Item | Monthly |
|---|---|
| API, 2 pods | $50 |
| Worker, 1 pod | $25 |
| Redis, managed | $30 |
| Postgres (Supabase Pro) | $25 |
| R2 | $5 + usage |
| Sentry, Resend, observability | $30 |
| **Total** | **~$165 (range $120–250)** |

Up from approximately zero on Netlify. This is the price of realtime and
background work, and it should be signed off before Phase 0 rather than
discovered in Phase 1.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Ops burden nobody currently owns | Runbook written in Phase 0, not after the first incident. Named on-call owner before Phase 1 ships. Bull Board, Sentry and `/ready` from day one |
| Provider lock-in | One Dockerfile, IaC in git, no proprietary runtime APIs |
| Redis becomes a single point of failure | Managed with automatic failover; every dependent path has a defined degradation |
| Cost growth with scale | Queue-depth-based worker autoscaling, R2 lifecycle rules, monthly cost review |
