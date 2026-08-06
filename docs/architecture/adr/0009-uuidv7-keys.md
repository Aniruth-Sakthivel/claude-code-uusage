# 0009 — UUIDv7 primary keys

**Status:** Accepted · 2026-08-06

## Context

The current schema uses `integer generated always as identity` for every primary
key. The new system needs client-generated ids for optimistic creates, and must
not foreclose a future workspace merge, split or multi-org model.

## Decision

`uuid` columns holding **UUIDv7** — time-ordered UUIDs — for every primary key.

Human-facing identity is separate: `issues.key` = `ENG-142`, generated from a
`project_counters.next_number` row incremented in the same transaction. **Users
never see a UUID.**

## Alternatives

**Identity integers.** Rejected for three reasons:

1. **They leak business volume.** `/issues/48211` tells any customer roughly how
   many issues exist. For a B2B product that is competitive information.
2. **They block client-generated ids.** Optimistic create needs the client to
   know the id before the server responds — otherwise the optimistic card cannot
   be reconciled with the created row, and every quick-add flickers.
3. **They make import and merge painful.** Importing 50k issues from Jira, or
   merging two workspaces, means id remapping across every foreign key.

**UUIDv4.** Rejected: random values destroy B-tree index locality. Inserts
scatter across the index, causing page splits and write amplification — measurably
worse on a 100M-row table. UUIDv7's time-ordered prefix keeps recent inserts
adjacent, which is the same property identity integers have.

**ULID.** Functionally equivalent to UUIDv7, but stored as text or a custom type
rather than native `uuid`. UUIDv7 wins on native Postgres support and tooling.

**Snowflake ids.** Rejected: requires coordinated node ids, which is
infrastructure this system does not otherwise need.

## Consequences

- 16 bytes per key rather than 4. Larger indexes and larger foreign keys —
  measurable but acceptable, and partly offset by the `INCLUDE` covering indexes
  that avoid heap lookups anyway
- UUIDs are unreadable in logs and support conversations. Mitigated entirely by
  `issues.key` — support talks about `ENG-142`, never a UUID
- Client-generated ids mean the server must handle a duplicate id gracefully
  (`ON CONFLICT DO NOTHING` plus a returned existing row), which also makes
  create idempotent for free
- Time-ordered ids leak approximate creation time. Acceptable — `created_at` is
  visible anyway

## Reversal

Effectively irreversible once data exists. This is why it is decided in Phase 0
rather than discovered in Phase 3.
