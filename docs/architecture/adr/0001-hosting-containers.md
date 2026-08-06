# 0001 — Containers, not serverless

**Status:** Accepted · 2026-08-06

## Context

The current system deploys as one Netlify site: SPA plus API as a single
serverless function. It costs approximately nothing and requires no operations,
which are real advantages.

The new requirements include WebSocket realtime, background jobs, cron, file
processing and long-running reports.

## Decision

Move the application runtime to containers — Render Web Service for API +
WebSocket, Render Background Worker for jobs, both from one Docker image.

## Alternatives

**Stay on Netlify functions.** Rejected. It blocks five required workloads
outright, not marginally:

| Workload | Blocker |
|---|---|
| WebSocket | No persistent process |
| Background jobs | No worker runtime |
| Cron | Shares the 26s cap, no retry semantics |
| File processing | 26s cap, no shared temp |
| Long reports | 26s cap, hard-coded in `netlify.toml` |

The evidence is already in the repository: `api/src/ws/server.ts` is 502 lines of
working, well-secured WebSocket code that **cannot be deployed for this reason**,
and production silently falls back to HTTP polling instead. That is not viable
for a board shared by thirty people.

The `max: 1` connection pool in `api/src/db/client.ts` is a further tax paid
purely to survive the model.

**Netlify functions + a separate worker host.** Rejected: two deploy targets, two
runtimes, split logs and traces, and the WebSocket problem remains.

**Kubernetes.** Rejected for now: the operational burden is disproportionate to a
three-service system, and nobody currently owns operations at all.

**Fly.io / Railway / ECS.** All viable. Render chosen for the combination of
native WebSocket support, background workers from the same image, declarative
`render.yaml`, and private networking to Redis. Since everything ships as a plain
Dockerfile, switching is a one-day exercise.

## Consequences

- **Cost rises from ~$0 to $120–250/month** at low scale. This must be signed off
  before Phase 0, not discovered in Phase 1
- Operations becomes real: pods, queues, dead-letter queues, on-call. A named
  owner and a runbook are Phase 0 deliverables
- The SPA moves to its own origin, so CORS must be configured explicitly. Auth
  moves to the `Authorization` header, which makes CSRF structurally impossible
- The pg pool grows from 1 to 10–20 per pod, removing a significant throughput
  constraint
- The WebSocket server merges into the API process — one deployable, one auth
  path, one pool

## Reversal

Serverless would become viable again only if realtime, jobs and long reports were
all dropped from the product. They are core requirements, so this is effectively
irreversible.

Provider choice, however, is deliberately cheap to reverse: one Dockerfile, IaC
in git, no proprietary runtime APIs.
