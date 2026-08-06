# 0008 — Cursor pagination

**Status:** Accepted · 2026-08-06

## Context

Boards, issue lists, activity feeds, comments, notifications and search results
are all paginated. All of them are append-heavy — rows are inserted while a user
is reading.

## Decision

Cursor pagination everywhere user-facing. The cursor is opaque base64 encoding
`(sortValue, id)`.

```json
{ "data": [...], "page": { "nextCursor": "eyJ2...", "hasMore": true } }
```

Offset pagination is permitted **only** on admin tables that genuinely need page
numbers, and capped at `offset <= 10000`.

## Alternatives

**Offset/limit everywhere.** Rejected for two independent reasons:

1. **Correctness.** Under concurrent inserts, offset pagination silently skips
   rows and duplicates others. A user scrolling a feed misses an item that
   exists and sees another twice. This is not an edge case in a realtime product
   — it is the normal case.
2. **Performance.** `OFFSET 10000` reads and discards 10,000 rows. Cost grows
   linearly with depth, so the deepest pages are the slowest.

**Keyset pagination with a raw sort value.** Rejected: it leaks the sort value
into the client contract, so changing the default sort becomes a breaking API
change. Opaque encoding avoids that.

**Cursor without a tiebreaker.** Rejected: when sort values collide — twenty
issues created in the same second — the page boundary is ambiguous and rows are
skipped or repeated. The `id` tiebreaker is what makes it correct.

## Consequences

- **No page numbers, and no total count.** Both are genuinely useful and both are
  given up. Total counts are provided separately, and approximately, where a UI
  needs them
- Cannot jump to page 47. Acceptable — nobody does this on an infinite-scrolling
  board; where it matters (admin tables), offset is allowed
- Sorting by a mutable field means a row can move across the boundary while
  paginating. Mitigated by including `id` and, for the worst cases, snapshotting
  an id set
- Every list endpoint and every client hook must be written for cursors from the
  start. Retrofitting is painful, which is why it is a Phase 0 convention

## Reversal

None foreseen. If a specific admin surface needs page numbers it uses the
sanctioned offset path — that escape hatch already exists rather than requiring a
decision reversal.
