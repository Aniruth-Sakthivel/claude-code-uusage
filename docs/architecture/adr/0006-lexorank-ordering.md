# 0006 — LexoRank strings for board ordering

**Status:** Accepted · 2026-08-06

## Context

Cards on a board and items in a backlog are manually ordered. A board column can
hold thousands of cards, and thirty people may drag on the same board at once.

The current schema uses `board_columns.position integer`, which is fine for eight
columns and wrong for five thousand cards.

## Decision

`issues.rank varchar(64)` holding a LexoRank-style string (e.g. `0|hzzzzz:`).

A drop computes the midpoint string between its two new neighbours — client-side,
since the client already knows them — and sends a **single-row UPDATE**.

A nightly worker rebalances any board whose ranks exceed 12 characters.

## Alternatives

**Integer position with reindexing.** Rejected:

- Inserting at position 3 rewrites every row after it — thousands of updates for
  one drag
- Two concurrent drags produce lost updates and duplicate positions, and the
  board order becomes non-deterministic
- The write amplification lands on the busiest table in the system

**Float position (midpoint between neighbours).** Rejected: doubles exhaust
precision after roughly 50 consecutive insertions at the same point. It fails
silently — two cards end up with identical ranks and the order flickers between
renders. This is a real, reported failure mode in products that chose it.

**Linked list (`prev_id` / `next_id`).** Rejected: reading a column in order
requires a recursive CTE, and a broken link corrupts the entire column with no
easy repair.

**Server-computed rank.** Rejected: it needs a round trip before the card can
move, which defeats optimistic UI. The client already knows the neighbours.

## Consequences

- Ranks grow in length over time; the nightly rebalance bounds it
- Rank strings are opaque and not human-meaningful — irrelevant, users never see
  them
- Rank arithmetic is non-trivial and must be unit-tested carefully, including
  the boundary cases (first, last, empty column)
- Combined with `If-Match`, two concurrent drags of the *same* card produce a 412
  rather than a lost update. Concurrent drags of *different* cards never conflict
- Client and server share one implementation in `packages/core/rank.ts`

## Verification

A property-based test applies **10,000 random concurrent moves** and asserts the
resulting order is a unique total order with no duplicates. This is the test that
catches the failure mode integers and floats exhibit.

## Reversal

None foreseen. LexoRank is the standard solution and Jira uses it for exactly
this problem.

If rebalancing ever becomes disruptive, the alternative is a wider alphabet
(base-62 rather than base-36), which extends the depth before rebalance without
changing the design.
