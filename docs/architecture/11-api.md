# API design

Fastify 5. Every request and response shape is a Zod schema in
`packages/contracts`; OpenAPI is generated from those schemas, so the docs cannot
drift from the implementation.

## 1. Shape

```
/api/v1/w/:workspaceSlug/...     workspace-scoped (almost everything)
/api/v1/me/...                   cross-workspace, self only
/api/v1/admin/...                org administration
/api/v1/auth/...                 unauthenticated
```

**Workspace in the path, not a header.** It appears in logs, traces, CDN cache
keys and error reports without extra plumbing. The slug is *input* — authority
comes from resolving it against `workspace_members`, which returns **404** when
absent so workspaces are not enumerable.

## 2. Versioning

`/api/v1` in the path. Additive changes never bump the version. A breaking change
mounts `/api/v2` alongside, and v1 is supported for 12 months.

Field-level deprecation ships ahead of that: a `Deprecation` and `Sunset` header
plus `X-API-Deprecated-Fields` listing what is going away, so integrators find
out from the response rather than from a changelog.

## 3. Pagination — cursor, everywhere that matters

```
GET /w/acme/issues?limit=50&cursor=eyJ2IjoiMjAyNi0wOC0wNiIsImlkIjoiMDE5..."

{ "data": [...],
  "page": { "nextCursor": "eyJ2...", "hasMore": true } }
```

The cursor is opaque base64 over `(sortValue, id)` — the tiebreaker `id` is what
makes it stable when sort values collide.

**Why not offset:** boards, feeds, comments, activity and search are all
append-heavy. Under concurrent inserts, offset pagination silently skips rows and
duplicates others — the user scrolls past an issue that exists and sees another
twice. It also degrades linearly, because `OFFSET 10000` reads and discards
10,000 rows.

Offset is permitted **only** on admin tables that genuinely need page numbers,
and capped at `offset <= 10000`.

## 4. Filtering and sorting — a typed AST, not a query DSL

```
GET /w/acme/issues
  ?status=in:todo,in_progress
  &assignee=me
  &label=all:bug,p1
  &due=lt:2026-02-01
  &cf.severity=eq:sev1
  &sort=-priority,created_at
  &fields=id,key,title,assignee,status
```

Operators: `eq: neq: in: nin: all: lt: lte: gt: gte: contains: null: between:`

`in:` is *any of*; `all:` is *every one of* — the distinction matters for labels
and is the kind of thing an ad-hoc parser gets wrong.

Parsed into a Zod-validated **filter AST**. Formalizing it is worth the effort
because **three consumers share it**:

| Consumer | Use |
|---|---|
| Saved views | Serializes the AST |
| Automation rule triggers | Stores the AST as the condition |
| Bulk operations | Accepts the AST as a selector |

One language, one parser, one test suite, one set of injection defences. The
alternative is three subtly different filter implementations, which is how
"the automation didn't fire but the view shows it" bugs are born.

Sorting is restricted to indexed columns and `is_filterable` custom fields. Any
other field returns `400` — an honest error rather than a query that table-scans
and times out.

## 5. Bulk operations

```
POST /w/:ws/issues/bulk
{
  "select": { "ids": ["..."] }
          |  { "filter": <AST>, "expectedCount": 137 },
  "patch":  { "status": "done", "labelsAdd": ["..."] }
}
```

- Max **500 ids**; beyond that the endpoint returns `202` with a job id and the
  work moves to BullMQ.
- A filter selector requires `expectedCount` — a guardrail against a filter that
  widened between the user previewing it and confirming.
- Executed in chunks of 100, one transaction per chunk.
- **Always partial success:**

```json
200 { "succeeded": ["..."], "failed": [{ "id": "...", "code": "forbidden" }] }
```

Never all-or-nothing at 500 items. One permission failure must not roll back 499
legitimate changes — that is a worse outcome than the partial result, and it is
what naive implementations do.

## 6. Concurrency and idempotency — two mechanisms, both required

They solve different problems and neither substitutes for the other.

### `If-Match` — lost update prevention

```
PATCH /w/acme/issues/019...
If-Match: 7

409/412 → { "detail": "This issue changed while you were editing",
            "code": "version_conflict",
            "current": { ...full current state... } }
```

Every editable entity carries `version`. The response to a conflict includes the
current server state, so the client can present a merge rather than silently
discarding the user's work.

This is what makes optimistic UI plus realtime **safe** instead of
last-write-wins.

### `Idempotency-Key` — safe retry

**Required** on invites, imports, exports, bulk operations and webhook replays;
optional elsewhere.

```
idempotency_keys(key, workspace_id, user_id, request_hash,
                 status, response_body, created_at)   -- 24h TTL
```

| Situation | Response |
|---|---|
| Same key, same body, completed | The stored response, replayed |
| Same key, different body | `422` — the key is being reused incorrectly |
| Same key, in flight | `409` with `Retry-After` |

## 7. Rate limiting — three tiers

| Tier | Where | Limit |
|---|---|---|
| 1 | Cloudflare edge, per IP | Coarse; DDoS and scraping |
| 2 | Redis token bucket, per user | 600 req/min sustained |
| 3 | Per endpoint class | search 30/min · export 5/hour · bulk 20/min · invite 50/day · webhook-test 10/min |

Tier 2 **must** be in Redis. `@fastify/rate-limit`'s in-memory store is
per-instance, so with two pods the effective limit is double the configured one
and neither pod knows it.

Headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus
`Retry-After` on `429`.

Rate limiting **fails open** if Redis is unavailable, with a logged warning.
Locking every user out because a cache is down is the worse failure.

## 8. Errors

Ported verbatim from `api/src/index.ts`, which already gets this right:

```json
{
  "detail": "Sprint name is required",
  "code": "validation_failed",
  "errors": [{ "field": "name", "message": "Required" }],
  "requestId": "0199...",
  "timestamp": "2026-08-06T04:21:39.684Z"
}
```

Three properties worth preserving deliberately:

1. A stable, machine-readable `code` — clients branch on it, never on `detail`.
2. `requestId` and `timestamp` injected by a `preSerialization` hook, so no
   handler has to remember them.
3. Raw Postgres errors mapped through `dbErrors.ts` — the driver message goes to
   `req.log.error` only. A constraint name in a response body is an information
   leak.

| Status | Use |
|---|---|
| 400 | Validation, unsupported sort |
| 401 | Missing or invalid token |
| 403 | Authenticated, lacks the capability |
| 404 | Not found **or** not visible — never distinguished |
| 409 | Idempotency key in flight, state conflict |
| 412 | `If-Match` version mismatch |
| 422 | Idempotency key reused with a different body |
| 429 | Rate limited |
| 503 | Dependency down; `Retry-After` set |

**403 vs 404 matters.** A resource the caller cannot see returns 404, always.
Returning 403 confirms it exists.

## 9. Webhooks

```
webhook_endpoints(workspace_id, url, secret, event_types[],
                  status, consecutive_failures)
```

**Signature** — Stripe-style, because the timestamp inside the signed payload is
what prevents replay:

```
X-Signature: t=1785989029,v1=<hmac_sha256(t + "." + rawBody)>
```

Receivers must reject a timestamp older than 5 minutes.

**Delivery** — BullMQ, backoff `1m, 5m, 30m, 2h, 6h, 12h, 24h` (7 attempts).
Each attempt is logged to `webhook_deliveries` with status, latency and the
first 2KB of the response body, which is what makes integration debugging
possible without a support ticket.

Auto-disable after 100 consecutive failures, with a notification to the
workspace admin.

**Events come off the outbox.** A webhook fires because a domain event happened,
never because a route handler remembered to call it.

**SSRF defence:** destination URLs are validated against an egress allowlist —
no private ranges, no link-local, no metadata endpoints — at save time *and*
again at delivery time, because DNS can be re-pointed in between.

## 10. Public API and tokens

- Personal access tokens, workspace-scoped, capability-limited, with
  `last_used_at`. Stored as sha256 hashes, never plaintext — the existing agent
  key model in `api/src/core/auth-agent.ts` is the pattern.
- Shown once at creation, revocable, with an optional expiry.
- OpenAPI served at `/api/v1/openapi.json` with a Scalar UI.
- Separate, lower rate-limit tier than interactive sessions.

## 11. Conventions

| | |
|---|---|
| Casing | `snake_case` in JSON, matching the current API |
| Dates | ISO 8601 with timezone, always UTC on the wire |
| Empty vs absent | `null` means "no value"; an absent key means "unchanged" in PATCH |
| Partial responses | `?fields=` projection on list endpoints |
| Expansion | `?expand=assignee,labels` — capped at 3 levels |
| Nesting | Two levels maximum. `/w/:ws/issues/:id/comments` is fine; deeper gets a top-level route |

## 12. Risks

| Risk | Mitigation |
|---|---|
| The filter AST becomes an injection surface | Parsed into a typed AST, never string-concatenated. Column names resolved against an allowlist derived from the schema |
| Cursor pagination breaks on a mutable sort key | Cursor encodes `(sortValue, id)`; sorting by a volatile field falls back to a snapshot id set |
| Bulk operations lock tables | Chunked at 100, one transaction per chunk, ordered by primary key to avoid deadlocks |
| Clients ignore `If-Match` | The API rejects `PATCH` without it on versioned entities — `428 Precondition Required` |
| Idempotency table grows unbounded | 24h TTL, purged by the retention job |
| Webhook receivers are slow | 10s timeout per attempt, delivery is queued and never blocks the request |
