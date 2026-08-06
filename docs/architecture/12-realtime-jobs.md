# Realtime and background jobs

Both are consumers of the same thing: the outbox.

## 1. The outbox dispatcher

```
outbox_events ──▶ dispatcher ──┬─▶ realtime      (Redis publish)
                               ├─▶ activity
                               ├─▶ notifications
                               ├─▶ automation
                               ├─▶ search-index
                               └─▶ webhooks
```

The dispatcher is a BullMQ consumer that polls:

```sql
SELECT * FROM outbox_events
WHERE processed_at IS NULL
ORDER BY id
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

`SKIP LOCKED` is what lets several dispatcher instances run without coordination
and without processing the same row twice.

Each consumer is enqueued as its own job with a **deterministic `jobId`**
(`{consumer}:{outboxId}`), so redelivery is a no-op. Only when every consumer has
acknowledged is `processed_at` set. Processed rows are purged after 7 days.

**Ordering:** `outbox_events.id` is a `bigserial`, giving a total order clients
can express as "everything after N". Per-entity ordering is guaranteed because
consumers process a single entity's events in id order; cross-entity ordering is
not guaranteed and nothing depends on it.

## 2. Realtime

### Transport

WebSocket, **inside the API process**, via `@fastify/websocket`. The current
separation into a standalone `ws-server` with its own pool (`api/src/ws/db.ts`)
existed only because Netlify could not host a persistent process. Merging gives
one deployable, one auth path, one pool, and one place where scoping lives.

### Port the security posture verbatim

`api/src/ws/server.ts` already gets things right that are commonly missed:

| Control | Detail |
|---|---|
| Auth before any frame is processed | Bad token → close **4401** immediately |
| `maxPayload` cap | Prevents memory exhaustion from one socket |
| Per-connection token bucket | 20 burst, 1/sec sustained |
| Zod validation on every inbound frame | No handler sees unvalidated input |
| Heartbeat + liveness sweep | 30s ping, 45s reap |
| **Scoped broadcasts** | Filtered through the same scoping REST uses |

That last row is the one people skip, and it is the one that leaks data.

Dashboard connections authenticate via `?token=` because browsers cannot set
headers on a native WebSocket. The token is validated once at upgrade and the
resulting `RequestContext` is held for the connection's life — with re-validation
forced on any permission-change event (§2.4).

### Cross-instance fan-out

With N API pods, a change on pod 1 must reach a socket on pod 3. Redis pub/sub:

```
channel: ws:{workspaceId}:{scope}
scope  ∈ project:<id> | issue:<id> | channel:<id> | board:<id> | user:<id>
```

Clients subscribe to scopes. Every subscription is validated against
`RequestContext` **at subscribe time**, and again when a permission-change event
arrives.

### Event envelope

```json
{ "type": "issue.updated",
  "seq": 918273,
  "workspaceId": "019...",
  "entityType": "issue",
  "entityId": "019...",
  "version": 8,
  "patch": { "status": "in_review" },
  "actorId": "019...",
  "ts": "2026-08-06T04:21:39.684Z" }
```

The client writes into the TanStack Query cache and **discards any event whose
`version <= cached.version`.**

That single rule makes out-of-order delivery and optimistic-update races
harmless, without needing any server-side ordering guarantee. An optimistic local
write and the inbound echo of that same write converge rather than fighting.

### Reconnection

On reconnect the client sends its last-seen `seq` per scope and the server
replays missed events from the outbox — bounded to 5 minutes. Beyond that the
client refetches, because replaying an hour of events is slower than a fresh
query.

### Degradation is mandatory

Exponential-backoff reconnect. After **3 consecutive failures the client falls
back to TanStack Query `refetchInterval`** — today's production behaviour becomes
the fallback path rather than the only path. A banner shows the degraded state so
"why isn't this updating" is answerable.

### Presence

Redis keys with TTL, never Postgres. Who is viewing an issue, who is typing.
Lost on Redis restart, which is correct — presence is ephemeral by definition.

### Permission revocation

Removing a member emits an outbox event that:
1. Publishes to `ws:{workspaceId}:user:{userId}`
2. Every pod holding that user's socket re-resolves `RequestContext`
3. Sockets whose subscriptions are no longer valid are unsubscribed; if the
   workspace membership is gone entirely, the socket is closed with 4403

Without this, a removed user keeps receiving updates until they reload.

## 3. Jobs

BullMQ on Redis, in `apps/worker`.

| Queue | Concurrency | Retries | Work |
|---|---|---|---|
| `outbox` | 10 | 10, exponential | The dispatcher |
| `search-index` | 5 | 5 | Upsert `search_documents` |
| `webhooks` | 20 | 7, exponential | Outbound delivery |
| `email` | 10 | 5 | Resend calls, digests |
| `files` | 4 | 3 | Thumbnails (sharp), PDF preview, checksum, AV scan |
| `reports` | 2 | 2 | Exports, scheduled reports, large CSV/XLSX — the workloads the 26s cap killed |
| `automation` | 5 | 3 | Rule evaluation and actions |
| `scheduled` | 2 | 3 | Recurring issues, sprint rollover, SLA checks, retention purge, rank rebalance, digest fan-out |

Concurrency differs per queue for a reason: `files` is CPU-bound (image
processing), `webhooks` is IO-bound and can run wide, `reports` is
memory-hungry and must not run wide.

### Rules

1. **Every job is idempotent**, with a deterministic `jobId`. Redelivery is a
   no-op, which is what makes at-least-once delivery acceptable.
2. **Every queue has a dead-letter queue** plus an admin UI listing failed jobs
   with a replay button. Silent job failure is the top source of "the system
   lied to me" bugs — a notification that never arrived looks identical to one
   that was never triggered.
3. **Bull Board** mounted at `/admin/queues`, behind the `view_audit`
   capability — the same gate the existing `/api/v1/metrics` route uses.
4. **Queue depth alerts** at 10,000 pending or 100 failed.

### Scheduling

Two layers, because they solve different problems:

- **Provider cron** triggers coarse schedules: "enqueue daily digests".
- **BullMQ repeatable jobs** do the per-workspace fan-out, with retries.

Cron alone cannot retry a partial failure across 40 workspaces; this split means
a failed digest for one workspace retries without re-sending the other 39.

Scheduled work:

| Job | Cadence |
|---|---|
| Digest emails | Daily / weekly, per user preference and timezone |
| Recurring issue materialization | Hourly |
| Sprint rollover reminders | Daily |
| SLA breach detection | Every 15 min |
| Retention purge (trash > 30 days) | Daily |
| LexoRank rebalance | Nightly, per board over threshold |
| Outbox purge (processed > 7 days) | Daily |
| Search reindex sweep (drift check) | Weekly |

## 4. Why not alternatives

| Alternative | Why not |
|---|---|
| Server-Sent Events | Chat, whiteboard and presence are genuinely bidirectional; SSE needs a second channel for the upstream half |
| Pusher / Ably / Supabase Realtime | Viable, and cuts ops. But it moves permission filtering somewhere that cannot share `RequestContext` — the exact bug class [03-tenancy.md](03-tenancy.md) exists to prevent. We already own working WS code |
| Postgres `LISTEN/NOTIFY` for fan-out | 8KB payload limit, no replay, and it consumes a connection per listener |
| pg-boss instead of BullMQ | Fewer moving parts, but Redis is needed anyway for pub/sub, presence and rate limits |

## 5. Risks

| Risk | Mitigation |
|---|---|
| Realtime consistency bugs — "my change disappeared" | Monotonic `version` + `If-Match` + drop-stale-version on the client. Deterministic Vitest tests over synthetic out-of-order event streams |
| Redis outage stops everything | Realtime degrades to polling; queues stall but the outbox loses nothing and drains on recovery; rate limiting fails open |
| Dispatcher falls behind | Depth alert at 10,000; horizontal scaling via `SKIP LOCKED` needs no coordination |
| A poisoned job blocks a queue | Bounded retries then DLQ; the queue never blocks on one message |
| Broadcast storm from a bulk edit | Bulk operations emit one coalesced event per entity, and the client debounces cache writes at 50ms |
| Socket count outgrows a pod | Sockets are stateless apart from subscriptions; scale pods horizontally, Redis fan-out is unchanged |
