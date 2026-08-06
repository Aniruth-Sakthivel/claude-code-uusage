# Search

## Decision: Postgres full-text search, not a dedicated engine

## 1. Design

A denormalized projection table, populated from the outbox:

```sql
search_documents (
  workspace_id  uuid not null,
  entity_type   varchar(32) not null,   -- issue | doc | project | comment | channel
  entity_id     uuid not null,
  project_id    uuid,                   -- for permission filtering
  title         text not null,
  body_text     text not null default '',
  search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', title), 'A') ||
      setweight(to_tsvector('english', body_text), 'B')
  ) STORED,
  updated_at    timestamptz not null,
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);

CREATE INDEX ON search_documents USING GIN (search_vector);
CREATE INDEX ON search_documents (workspace_id, project_id);
```

Ranking is `ts_rank_cd` with a recency decay and a per-entity-type boost, so a
stale doc does not outrank the issue someone touched an hour ago.

**Typeahead is a separate mechanism.** FTS handles prefix and fuzzy matching
badly, so the command palette hits a `pg_trgm` GIN index on `issues.title` and
`issues.key` for sub-50ms results while typing. Two indexes, two query shapes,
each good at its job.

Population is the `search-index` consumer: an entity mutation emits an outbox
event, the consumer upserts the row. Deletes remove it. A weekly sweep detects
drift between `issues.updated_at` and `search_documents.updated_at` and repairs
it — because "the index is stale and nobody noticed" is the failure mode of every
async indexing design.

## 2. Why Postgres wins here

### Permission filtering is the whole game

Search must return only what this user can see: workspace, project membership,
client shares, archived state, soft-delete. In Postgres that is `AND` clauses in
the same query against the same tables the permission model already uses:

```sql
WHERE workspace_id = $1
  AND (project_id IS NULL OR project_id = ANY($2))   -- the scope guard, reused
  AND search_vector @@ websearch_to_tsquery('english', $3)
```

With Typesense, Meilisearch or Elasticsearch you must denormalize an ACL array
into **every document**, and re-index every affected document whenever a
membership changes. "Remove user from project" becomes a fan-out of thousands of
document writes — and there is a **stale-ACL window while it drains** during
which the removed user's search still returns the project's contents.

That is a data leak with a queue depth attached to it. It is the single strongest
argument in this document.

### The scale genuinely fits

One organization, many workspaces. Realistically under 5M searchable rows for
years. Postgres GIN handles that comfortably under 100ms.

### No new stateful service

No second system to back up, monitor, secure, version, or reconcile against the
database. The operational surface stays one Postgres.

## 3. What we give up, honestly

| Missing | Impact | Mitigation |
|---|---|---|
| Typo tolerance | "recieve" finds nothing | `pg_trgm` similarity as a fallback when FTS returns zero rows |
| Faceted counts | No "23 in Engineering" next to filters | Computed as a separate aggregate query, capped at 5 facets |
| Multi-language stemming | English config only | Acceptable — the UI is English-only at launch |
| Synonyms | "bug" doesn't match "defect" | A small curated `ts_thesaurus` if it becomes a complaint |
| Sub-10ms latency | We target <200ms | Well within NFR-5 |

## 4. The escape hatch is designed in

Because indexing goes through **one consumer** writing to **one table**, queried
by **one function**, swapping engines means replacing three things — not
rewriting search across the product.

Trip-wires, written down now so the decision has criteria rather than vibes:

- p95 search latency > **400ms** sustained for a week
- corpus > **20M** documents
- a product requirement for typo-tolerance **and** faceting **and**
  multi-language stemming simultaneously

If any fires, Typesense is the successor — and the ACL problem must be solved
before the migration, not during it.

Recorded in [adr/0005-search-engine.md](adr/0005-search-engine.md).

## 5. API

```
GET /w/:ws/search?q=login+bug&type=issue,doc&project=019...&limit=20
```

```json
{ "results": [
    { "type": "issue", "id": "019...", "key": "ENG-142",
      "title": "Login fails on Safari", "snippet": "…the <mark>login</mark> flow…",
      "score": 0.82, "projectId": "019..." }
  ],
  "facets": { "type": { "issue": 18, "doc": 3 } },
  "degraded": false
}
```

`degraded: true` when the index is unavailable and the query fell back to
`ILIKE` on titles — surfaced in the UI as "results may be incomplete" rather
than silently returning less.

Snippets come from `ts_headline`, capped at 200 characters.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Index drifts from source of truth | Weekly reconciliation sweep comparing `updated_at`; alert on drift over 0.1% |
| `search_documents` doubles storage | `body_text` truncated at 100KB per document; only searchable fields are projected |
| GIN index write amplification on bulk import | Import jobs defer indexing and enqueue a single bulk reindex at the end |
| A workspace with 5M issues dominates the index | Per-workspace query always filters `workspace_id` first, and the GIN index is intersected with that btree |
| Ranking quality complaints | Ranking weights are configuration, not code; a relevance test set of 30 known queries guards regressions |
