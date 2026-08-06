# 0003 — Transactional outbox for all side-effects

**Status:** Accepted · 2026-08-06

## Context

Six concerns must react to every domain mutation: realtime push, the activity
feed, notifications, automation rules, the search index, and outbound webhooks.

In the current codebase all six are called inline from `api/src/services/pm.ts`,
in the request path, with no retry. Three defects follow directly:

- A failed notification write fails the user's save
- A committed mutation whose side-effect throws loses that side-effect silently
- A rolled-back transaction can still have fired a notification

## Decision

Every service mutation writes the entity row **and** an `outbox_events` row in
the same transaction. A dispatcher polls unprocessed events with
`FOR UPDATE SKIP LOCKED` and fans each out to the six consumers as independently
retried jobs.

`outbox_events.id` is a `bigserial`, giving a total order that reconnecting
clients can express as "everything after N".

## Alternatives

**Keep inline calls.** Rejected — it is the defect being fixed.

**Publish to a message broker inside the transaction.** Rejected: a broker
publish is not transactional with the database write. Either the commit succeeds
and the publish fails, or the reverse. This is the dual-write problem the outbox
pattern exists to solve.

**Postgres `LISTEN/NOTIFY`.** Rejected: 8KB payload limit, no replay, no
durability if nothing is listening, and one connection consumed per listener.

**Logical replication / CDC (Debezium).** Rejected as overkill for this scale,
and it produces row-level changes rather than domain events — consumers would
have to reconstruct intent from column diffs.

**Only realtime through the outbox, the rest inline.** Rejected: the retry and
atomicity properties are exactly as valuable for notifications and webhooks, and
two mechanisms is worse than one.

## Consequences

- One extra insert per mutation. Negligible — same transaction, same page
- Side-effects become **eventually** consistent, typically under a second. The UI
  must not assume a notification exists the instant a mutation returns
- The dispatcher is a new component that can fall behind, so `outbox_lag_seconds`
  becomes the system's most important health metric
- Consumers must be idempotent, because delivery is at-least-once. Deterministic
  `jobId` per `(consumer, outboxId)` makes redelivery a no-op
- Replay for reconnecting clients comes free — the event log already exists
- `outbox_events` needs purging (7 days after processing) or it grows forever

## Reversal

None foreseen. The pattern is well understood and the alternatives each fail on
atomicity, durability or replay.

If the dispatcher becomes a throughput bottleneck past ~5,000 events/sec,
partition `outbox_events` by `workspace_id` hash and shard dispatchers by
partition — a migration, not a redesign, because the partition key is chosen now.
