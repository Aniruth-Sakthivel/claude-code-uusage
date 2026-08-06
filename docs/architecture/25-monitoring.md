# Monitoring and logging

## 1. Starting position

The current system has genuinely good structured logging and an in-process
metrics snapshot, and **no error tracking at all**. An unhandled React render
error produces nothing, anywhere. That is the first gap to close.

What is worth porting verbatim from `api/src/index.ts`:

- `genReqId: randomUUID()` per request
- Fastify's default double-logging disabled, replaced by **one** `onResponse`
  line carrying `{requestId, userId, systemId, route, method, statusCode,
  durationMs}` — which is already the shape of an OpenTelemetry span
- `x-request-id` response header, and `requestId`/`timestamp` injected into every
  JSON response by a `preSerialization` hook
- Errors mapped through `dbErrors.ts` so driver messages never leave the log

## 2. Logging

| Property | Choice |
|---|---|
| Format | JSON, Pino |
| Level | `warn` in production, `info` in development, silent in test |
| One line per request | On `onResponse`, never on request start |
| Correlation | `requestId` on every line; propagated to jobs and WebSocket frames |
| Destination | stdout → platform collector → Axiom or Grafana Cloud |
| Retention | 30 days hot, 1 year archived |

**Never logged:** secrets, tokens, passwords, message bodies, document contents,
file contents, AI prompts containing user data. This is a review checklist item,
not just a comment in the code.

Correlation extends across the outbox: a job log line carries the `requestId` of
the mutation that produced its event, so a webhook delivery failure traces back
to the click that caused it.

## 3. Metrics

OpenTelemetry, exported to the platform. The current in-process
`core/metrics.ts` snapshot is honest about its limits — per-warm-instance,
reset by cold starts, blind to the WebSocket process — and those limits
disappear once metrics leave the process.

| Metric | Type | Labels |
|---|---|---|
| `http_request_duration` | Histogram | route, method, status |
| `http_requests_total` | Counter | route, method, status |
| `db_query_duration` | Histogram | repository, operation |
| `outbox_lag_seconds` | Gauge | — |
| `queue_depth` | Gauge | queue |
| `queue_job_duration` | Histogram | queue, status |
| `ws_connections` | Gauge | pod |
| `ws_events_published` | Counter | event type |
| `realtime_delivery_latency` | Histogram | — |
| `search_duration` | Histogram | — |
| `ai_cost_cents` | Counter | workspace, feature |
| `cache_hit_ratio` | Gauge | cache |

`outbox_lag_seconds` — the age of the oldest unprocessed event — is the single
best health indicator in the system. If it is near zero, the whole side-effect
pipeline is working.

## 4. Tracing

Distributed tracing across the full path:

```
browser fetch → API span → repository span → Postgres
                        └→ outbox insert
                              → dispatcher span (linked)
                                    → consumer spans (linked)
                                          → webhook delivery span
```

Trace links across the outbox are what make "why did this webhook fire late"
answerable in one view.

Sampling: 100% of errors, 100% of slow requests (>1s), 5% of the rest.

## 5. Error tracking

Sentry, both ends.

| | |
|---|---|
| Backend | Every unhandled error and every 5xx, with `requestId`, user, workspace, route |
| Frontend | Render errors, unhandled rejections, failed mutations |
| Source maps | Uploaded at build, not served publicly |
| Release tracking | Tagged with the commit SHA, so a regression names its deploy |
| PII | Scrubbed before send — no message bodies, no field values |

Alert on a new issue type, or a spike over baseline.

## 6. Health probes

Ported from `api/src/index.ts`, including the property that matters:

| Endpoint | Checks | Rule |
|---|---|---|
| `/live` | Process is up | **Never touches the database.** A slow query answering liveness restarts every pod at once |
| `/ready` | Postgres, Redis reachable | Fails during shutdown so the balancer drains |
| `/api/v1/health` | Dependency status, degraded rather than failed | Always 200; the body carries the detail |
| `/api/v1/metrics` | Snapshot, behind `view_audit` | |

## 7. Alerts

Tiered by what a human should actually do about it.

**Page immediately**

| Condition | Why |
|---|---|
| Error rate > 5% for 5 min | Users are affected now |
| `/ready` failing on > 50% of pods | Outage |
| Postgres connections > 90% | Minutes from an outage |
| `outbox_lag_seconds` > 300 | Every side-effect in the system is stalled |
| **Any cross-tenant assertion failure in production canaries** | Existential |

**Notify during business hours**

| Condition |
|---|
| API p95 over budget for 15 min |
| Queue depth > 10,000 |
| Failed jobs > 100 |
| Search p95 > 400ms (the engine trip-wire) |
| Disk > 80% |
| AI spend > 80% of a workspace budget |
| Webhook endpoint auto-disabled |

**Report weekly**

Slow queries without an index · bundle size trend · cache hit ratio · dependency
vulnerabilities · stale feature flags · storage growth.

## 8. Dashboards

| Dashboard | Audience | Content |
|---|---|---|
| Service health | On-call | Error rate, latency, saturation, dependency status |
| Queues | On-call | Depth, throughput, failures, DLQ, outbox lag |
| Realtime | On-call | Connections, publish rate, delivery latency, fallback rate |
| Database | On-call | Connections, slow queries, cache hit ratio, replication lag |
| Product | Team | DAU, issues created, workspaces active, feature adoption |
| Cost | Team | Infrastructure, AI spend, storage, per workspace |

The realtime **fallback rate** — what fraction of clients gave up on WebSocket
and are polling — is the metric that tells you realtime is quietly broken while
everything else looks green.

## 9. SLOs

| SLO | Target | Window |
|---|---|---|
| Availability | 99.9% | 30 days |
| API p95 read latency | < 200ms | 7 days |
| Realtime delivery p95 | < 500ms | 7 days |
| Job success rate | > 99.5% | 7 days |
| Error budget | 43 min/month | |

When the error budget is exhausted, feature work stops and reliability work
starts. Written down in advance so it is a policy rather than an argument.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Alert fatigue → real alerts ignored | Three tiers; only genuine user impact pages; every alert has a runbook entry |
| Logs contain user content | Redaction reviewed in PR; automated scan for high-entropy strings |
| Observability cost grows unbounded | Sampling, 30-day hot retention, monthly review |
| Metrics exist but nobody looks | Dashboards reviewed in weekly ops; SLO breach is an agenda item |
| A silent failure has no signal | `outbox_lag_seconds` and the realtime fallback rate specifically exist to catch the two quietest failures |
