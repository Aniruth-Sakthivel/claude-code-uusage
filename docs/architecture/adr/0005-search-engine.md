# 0005 — Postgres FTS, not a dedicated search engine

**Status:** Accepted · 2026-08-06

## Context

Search must span issues, docs, projects, comments and channels, and must return
**only** what the caller is permitted to see: workspace, project membership,
client shares, archived and soft-deleted state.

The current implementation is `ILIKE '%term%'` on titles only, which cannot use
an index and does not search bodies at all.

## Decision

A denormalized `search_documents` table with a generated `tsvector`
(title weight A, body weight B), a `GIN` index, populated by a `search-index`
consumer off the outbox. A separate `pg_trgm` GIN index on `issues.title` and
`issues.key` serves typeahead.

## Alternatives

**Typesense / Meilisearch / Elasticsearch.** Rejected, primarily on one point:

**Permission filtering is the whole game.** In Postgres, filtering by
workspace and project membership is `AND` clauses in the same query against the
same tables the permission model already uses — the scope guard is reused
directly.

With an external engine you must denormalize an ACL array into **every
document**, and re-index every affected document whenever membership changes.
"Remove user from project" becomes a fan-out of thousands of document writes,
with a **stale-ACL window while it drains** during which the removed user's
search still returns that project's contents.

That is a data leak with a queue depth attached to it.

Secondary reasons: a second stateful service to back up, monitor, secure and
version; index/database consistency to reconcile; and a corpus that realistically
stays under 5M rows for years, which Postgres GIN handles comfortably under
100ms.

**Postgres FTS queried directly against source tables.** Rejected: a `tsvector`
computed across five tables with different shapes needs a UNION per query, and
each table pays the index-maintenance cost on every write.

**Vector / semantic search.** Rejected for v1 — users searching a project tool
expect lexical matching ("ENG-142", "login timeout"), and semantic search
surprises them. Revisit as an *additional* mode, not a replacement.

## Consequences

Accepted losses, each with a fallback:

| Loss | Fallback |
|---|---|
| Typo tolerance | `pg_trgm` similarity when FTS returns nothing |
| Faceted counts | Separate aggregate query, capped at 5 facets |
| Multi-language stemming | English only — the UI is English at launch |
| Synonyms | A curated `ts_thesaurus` if it becomes a complaint |

- `search_documents` roughly doubles the storage of searchable text.
  `body_text` is truncated at 100KB per document
- The index is asynchronous, so it can drift. A weekly reconciliation sweep
  compares `updated_at` and repairs, with an alert over 0.1% drift
- Bulk imports defer indexing and enqueue one bulk reindex at the end

## Reversal

The escape hatch is designed in: indexing is **one consumer** writing **one
table**, queried by **one function**. Swapping engines replaces three things.

Trip-wires, any one of which triggers a re-evaluation:

- p95 search latency > **400ms** sustained for a week
- corpus > **20M** documents
- a product requirement for typo tolerance **and** faceting **and**
  multi-language stemming simultaneously

Typesense is the presumed successor. **The ACL problem must be solved before the
migration, not during it.**
