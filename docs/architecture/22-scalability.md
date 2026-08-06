# Scalability

## 1. What we are actually designing for

Be honest about the target, because over-designing costs more than it saves:

| Dimension | Launch | Design target | Would require rework |
|---|---|---|---|
| Organizations | 1 | 1 | Multi-org: one resolution step, by design |
| Workspaces | 10s | 1,000s | — |
| Users | 100s | 100,000 | Sharding beyond that |
| Issues | 100,000s | 100M | Table partitioning past ~50M/table |
| Concurrent sockets | 100s | 100,000 | Fine — pods are horizontal |
| Events/sec | 10s | 5,000 | Outbox partitioning past that |

Single region throughout. Multi-region is a different product with different
consistency guarantees, and nothing in the requirements asks for it.

## 2. Horizontal scaling

| Tier | Scales on | Constraint |
|---|---|---|
| API + WS pods | CPU, socket count | Stateless apart from socket subscriptions; Redis carries fan-out |
| Worker pods | Queue depth | `FOR UPDATE SKIP LOCKED` needs no coordination |
| Postgres | Vertical, then read replicas | The eventual ceiling |
| Redis | Vertical, then cluster | Pub/sub and queues split first |
| R2 | Unbounded | — |

**Postgres is the ceiling**, and it is a high one. Order of escalation:

1. Vertical scaling — a long way on managed Postgres
2. Read replicas for reporting and search, with the primary reserved for writes
3. Table partitioning (`activity`, `notifications`, `chat_messages`,
   `webhook_deliveries`)
4. Move `activity` and `entity_versions` to a separate database — they are
   append-only and join to nothing on the hot path
5. Only then: workspace sharding

Steps 1–4 cover the design target. Step 5 is noted so that nothing in the schema
makes it impossible — which is what workspace-scoped keys and UUIDv7 PKs buy.

## 3. Stateless services

Nothing in an API pod survives a restart except open sockets, which reconnect.

- No in-memory session state — the JWT carries identity
- No in-memory rate-limit counters — Redis, or the limit is per-pod and wrong
- No in-memory cache of authoritative data — only derived values with short TTLs
- No sticky sessions required

This is what makes autoscaling and zero-downtime deploys work at all.

## 4. Data growth

| Table | Growth driver | Strategy |
|---|---|---|
| `issues` | Core | Indexed workspace-first; partition past 50M |
| `activity` | **Fastest-growing** | BRIN, 12-month retention, monthly partitions past 50M |
| `entity_versions` | Every edit | Deltas for issues, snapshots for docs; 12-month thinning |
| `chat_messages` | Chat usage | Monthly partitions past 50M |
| `notifications` | Fan-out multiplier | 90-day retention, monthly partitions |
| `outbox_events` | Every mutation | Purged 7 days after processing — bounded by design |
| `webhook_deliveries` | Endpoint count × events | BRIN, 90-day retention |
| `search_documents` | One row per entity | Bounded by entity count; `body_text` truncated at 100KB |
| `files` | Uploads | R2, lifecycle rules, per-workspace quota |

The pattern: **everything append-only gets BRIN, a retention policy, and a
partitioning trigger point written down in advance.**

## 5. The outbox at scale

The one component every mutation touches, so it deserves specific attention.

- Insert cost is one row per mutation, in the same transaction — negligible
- The dispatcher's only query is covered by
  `(processed_at, id) WHERE processed_at IS NULL`, which stays small because
  processed rows leave the partial index
- Multiple dispatchers coordinate through `SKIP LOCKED` alone
- Processed rows purge after 7 days

Past ~5,000 events/sec: partition `outbox_events` by `workspace_id` hash and
shard dispatchers by partition. Not needed at the design target, but the
partition key is chosen now so it is a migration rather than a redesign.

## 6. Realtime at scale

| Concern | Approach |
|---|---|
| Sockets per pod | ~5,000 comfortably; scale pods horizontally |
| Fan-out | Redis pub/sub, one channel per workspace scope |
| Subscription storms | Reference-counted client-side; a board subscribes once |
| Broadcast amplification from bulk edits | One coalesced event per entity, 50ms client-side debounce |
| Presence | Redis TTL keys, never Postgres |

## 7. Cost curve

| Scale | Monthly |
|---|---|
| Launch (100 users) | ~$165 |
| 1,000 users | ~$400 |
| 10,000 users | ~$1,500 |
| 100,000 users | ~$8,000 |

Superlinear at the top end because Postgres moves to a larger instance class plus
replicas. Reviewed monthly; worker autoscaling on queue depth prevents idle spend.

## 8. Load testing

Before enterprise launch, and quarterly after:

| Scenario | Target |
|---|---|
| 500 concurrent users on one board | p95 < 1s, no dropped events |
| 10,000 concurrent WebSocket connections | Stable memory, < 5% CPU per pod |
| 100k-issue bulk import | Completes, no timeouts, queues drain |
| 1,000 events/sec sustained through the outbox | No backlog growth |
| Search under load | p95 < 200ms at 100 qps |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Postgres becomes the ceiling sooner than expected | Escalation path written above; read replicas are a config change, not a rewrite |
| One large workspace degrades others | Per-workspace rate limits; every query bounded by cursor pages |
| `activity` growth outruns everything | Partitioning trigger at 50M, retention enforced by a job, monitored |
| Redis becomes a single point of failure | Managed with failover; every dependent path has a defined degradation |
| Autoscaling thrashes | Conservative thresholds, 5-minute cooldown |
| Sharding is needed and the schema fights it | Workspace-scoped keys and UUIDv7 PKs from day one keep it possible |
