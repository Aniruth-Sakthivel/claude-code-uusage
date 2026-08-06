# Performance

## 1. Budgets

Treated as tests, not aspirations. Each has a CI assertion or a monitored alert.

| Metric | Budget | Enforced by |
|---|---|---|
| Board interactive, 2,000 cards | p95 < 1.0s | Playwright timing against a seeded fixture |
| List scroll, 10,000 rows | 60fps | React Profiler, manual |
| API read | p95 < 200ms | OTel histogram + alert |
| API write | p95 < 400ms | OTel histogram + alert |
| Search | p95 < 200ms | OTel + trip-wire at 400ms |
| Realtime end-to-end | p95 < 500ms | Synthetic probe |
| Initial JS | < 180KB gzipped | CI budget, **hard fail** |
| Largest Contentful Paint | < 1.5s | Lighthouse in CI |
| Any single query | < 100ms p95 | `pg_stat_statements` weekly report |

## 2. Database

**Index-only scans for hot paths.** The board query is the canonical example:

```sql
CREATE INDEX ON issues (workspace_id, project_id, status, rank)
  INCLUDE (title, assignee_id, priority, type)
  WHERE deleted_at IS NULL;
```

The `INCLUDE` carries the entire card payload, so rendering a column never
touches the heap.

| Technique | Application |
|---|---|
| Partial indexes | `WHERE deleted_at IS NULL` — smaller, and matches what `scoped()` emits |
| Covering indexes | Board, my-work, notification list |
| BRIN | `activity`, `webhook_deliveries` — append-only, ~1000× smaller than btree |
| Cursor pagination | Everywhere; no `OFFSET` on user-facing lists |
| Pre-aggregation | Daily rollups for dashboards, never raw scans |
| `EXPLAIN` assertions | CI checks the top 20 query shapes still use their index |

That last row is the one that prevents slow regression: a query plan silently
changing from index scan to sequential scan is invisible until it is an incident.

## 3. N+1 elimination

The current codebase already demonstrates the pattern worth keeping — the
accounts page assembles everything in four queries rather than N+1. Generalize:

- Batch loaders for `assignee`, `labels`, `watchers` across a result set
- `?expand=` capped at 3 levels
- A lint rule flagging `await` inside a `for` loop over query results

## 4. Caching

| Layer | Store | TTL | Invalidation |
|---|---|---|---|
| Principal | Redis | 30s | Membership change event |
| Feature flags | In-process | 30s | Poll |
| Workspace settings | Redis | 5 min | On write |
| Search facets | Redis | 60s | Time only |
| Static assets | Cloudflare | 1 year | Content hash in filename |
| API responses | None | — | Deliberate: correctness over a small win |

**No API response caching.** With realtime updates and optimistic UI, a stale
response is worse than a slightly slower fresh one, and the invalidation
complexity is not worth 20ms.

## 5. Frontend

| Technique | Where |
|---|---|
| Route-level code splitting | Every module; board, Gantt, whiteboard and editor never in the initial chunk |
| Virtualization | Lists, and **per-column** inside the Kanban board |
| Structural sharing | TanStack Query — unchanged rows keep identity and skip re-render |
| Prefetch on hover | Issue rows, project links |
| Debounced realtime writes | 50ms coalescing, so a bulk edit is one render, not 500 |
| Optimistic mutations | Every write; perceived latency near zero |
| `content-visibility: auto` | Long documents |

## 6. Payload

- `?fields=` projection on list endpoints — a board does not need issue
  descriptions
- Gzip/Brotli at the edge
- Cursor pages of 50 by default, 200 maximum
- Realtime events carry a `patch`, not the whole entity

## 7. Backend

- Connection pool `max: 10–20` per pod, sized against the Postgres limit divided
  by peak pod count
- No blocking work in the request path — anything over 500ms becomes a job
- Streaming for exports; never buffer 100k rows in memory
- `sharp` for image processing in the worker, off the API pods entirely

## 8. Testing performance

A seeded fixture representing a *large* workspace exists from Phase 0 and is used
by CI:

```
1 workspace · 200 users · 50 projects
500,000 issues · 2,000 in the largest board column
100,000 comments · 1,000 docs · 50,000 time entries
```

Budgets are asserted against that fixture, not against an empty database. A
board that is fast with 12 cards tells you nothing.

## 9. Monitoring

| Signal | Alert |
|---|---|
| API p95 by route | > budget for 5 min |
| Slow query log | Any query > 100ms p95 |
| Queue depth | > 10,000 pending |
| WebSocket count per pod | > 5,000 |
| Cache hit ratio | < 80% |
| Bundle size | Any increase over budget, at PR time |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Performance regresses gradually and invisibly | Budgets as CI assertions against the large fixture, not manual checks |
| Custom fields make every list query conditional | Filterable cap, separate index table, `EXPLAIN` assertions |
| A single large workspace degrades everyone | Per-workspace rate limits; the worst query is bounded by cursor pages |
| Realtime fan-out becomes the bottleneck | Redis pub/sub scales horizontally; events are small patches |
| Bundle creep | Hard CI fail, analyzer output in every PR |
