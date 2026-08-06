# 0010 — TanStack Query + URL state + Zustand, no Redux

**Status:** Accepted · 2026-08-06

## Context

The UI has three genuinely different kinds of state: data owned by the server,
view configuration (filters, sort, grouping, selection), and ephemeral
interaction state (drag in flight, panel widths).

Most frontend complexity in applications of this size comes from storing all
three in one place.

## Decision

Three tiers, strictly separated:

| Tier | Store | Contents |
|---|---|---|
| Server state | **TanStack Query**, exclusively | Everything fetched from the API |
| View configuration | **The URL** | Filters, sort, grouping, active view, selected issue, open panel |
| Ephemeral UI | **Zustand**, one small store per feature | Drag state, palette open, panel widths, multi-select |

Nothing from the server is copied into component state "so it can be edited" —
that is what mutations and optimistic updates are for.

## Alternatives

**Redux / Redux Toolkit for everything.** Rejected: server data in Redux means
hand-writing caching, invalidation, deduplication, background refetch, and
retry — all of which TanStack Query provides and does better. RTK Query would
solve that, but then Redux is only holding the ephemeral tier, which does not
justify the ceremony.

**Everything in Zustand.** Rejected: same reason. Reimplementing a query cache is
not a good use of the project's weeks.

**Component state for filters.** Rejected, and this is the interesting one.
Putting view configuration in the URL yields two product features for free:

1. **Every view is shareable by link.** "Look at this board filtered to my P1
   bugs" becomes a URL rather than a screenshot.
2. **Saved views become trivial** — they serialize state that is already
   serializable, rather than needing a parallel representation.

**Server-side state for the active view.** Rejected: a round trip to change a
filter is unacceptable, and it breaks the back button.

## Consequences

- Developers must know which tier a piece of state belongs to. A lint rule flags
  query-shaped types inside Zustand stores, and code review covers the rest
- URLs get long with complex filters. Mitigated by compressing long filters to a
  short id backed by a saved view
- The URL is typed against the filter AST from the API, so client and server
  agree on the filter language by construction
- Realtime updates write directly into the TanStack Query cache via
  `setQueryData`, with version-based reconciliation — there is exactly one place
  server data lives, so there is exactly one place to update
- No global store to debug. Query devtools show cache state; Zustand stores are
  small and local

## Reversal

If a genuine need for cross-feature shared ephemeral state emerges that Zustand
cannot express cleanly, revisit. Nothing in the design depends on Zustand
specifically — the tier boundary is the decision, not the library.
