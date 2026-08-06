# Security

## 1. The threat that matters most

**Cross-workspace data access.** Everything else on this page is standard
practice; this one is existential and specific to the architecture.

It is addressed structurally in [03-tenancy.md](03-tenancy.md) rather than by
review discipline, because review discipline does not scale to 200 repository
functions maintained over years.

## 2. Authentication

| Control | Detail |
|---|---|
| Identity provider | Supabase Auth. Passwords never touch our database |
| Token | ES256 JWT, verified against the remote JWKS with `jose`, cached 10 min. **No shared secret** |
| Verification | `audience: "authenticated"`, 10s clock tolerance |
| Principal resolution | Every request; 30s cache. Role and membership changes take effect immediately |
| MFA | TOTP via Supabase, optionally enforced per workspace |
| Sessions | Listed and individually revocable; revocation reaches open WebSockets within 60s |
| Service credentials | PATs and agent keys stored as sha256 hashes, compared with `timingSafeEqual`, prefix stored separately for display |

Ported from `api/src/core/auth-user.ts` and `auth-agent.ts`, both of which
already do this correctly.

## 3. Authorization

Two orthogonal mechanisms, and conflating them is the classic mistake:

- **Capabilities gate actions.** Can this role invite members?
- **Scoping gates data.** Which projects can this principal see?

A user may have `write_issues` and still see nothing, because their project scope
is empty. That is correct, and the empty case must return **zero** rows.

Enforcement points:

| Layer | Control |
|---|---|
| Route | `requireCapability(cap)`, `requireStaff` (excludes client role) |
| Service | Business invariants — last admin, self-approval, role ceiling |
| **Repository** | `scoped(table, ctx)` — the real boundary |
| Database | Partial unique indexes, FK constraints, append-only grants on audit |

## 4. Input handling

- **Every request body, query and param is a Zod schema** from
  `packages/contracts`. There is no unvalidated path into a handler.
- **All SQL is parameterized** through Drizzle. Raw `sql` templates are reviewed;
  column names in the filter AST resolve against a schema-derived allowlist, never
  string interpolation.
- **Rich text is sanitized server-side on write** and escaped on render. Both,
  not either.
- **File uploads**: presigned PUT with a server-generated key, content-type
  allowlist, size cap, `Content-Disposition: attachment`, served from a separate
  origin so a stored HTML file cannot execute against the app origin.

## 5. Output handling

| Control | Detail |
|---|---|
| 404 over 403 | A resource the caller cannot see returns 404, always. 403 confirms existence |
| No driver errors | Postgres errors mapped through `dbErrors.ts`; the raw message goes to the log only. A constraint name in a response is an information leak |
| Field projection | `?fields=` never widens beyond what the scope allows |
| Notifications | Permission re-checked at **send** time, not only at trigger time |

## 6. Transport and headers

- TLS everywhere; HSTS with preload
- **Auth token in the `Authorization` header, never a cookie** — CSRF becomes
  structurally impossible rather than mitigated
- Strict CORS allowlist, credentials off
- CSP with no `unsafe-inline` for scripts; nonce-based
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` — already set in the current
  `netlify.toml`, carried forward

## 7. Rate limiting and abuse

Three tiers ([11-api.md](11-api.md)). Tier 2 **must** be Redis-backed — an
in-memory limiter across two pods enforces double the configured limit and
neither pod knows.

Fails open on Redis failure, with a logged warning. Locking every user out
because a cache is down is the worse outcome.

Specific limits: sign-in per IP and per email; invitations 50/day; exports
5/hour; webhook tests 10/min; AI calls per workspace budget.

## 8. SSRF — the sharpest edge in the system

Webhooks and calendar integrations fetch **user-controlled URLs from our
server**. That is the textbook SSRF setup.

| Control | Detail |
|---|---|
| Egress allowlist | No private ranges (RFC1918), no loopback, no link-local, no cloud metadata endpoints |
| Validated twice | At save **and again at delivery** — DNS can be re-pointed in between |
| No redirects followed | A 30x from a webhook target is a failure, not a hop |
| Timeout | 10s per attempt |
| Separate egress path | Worker outbound traffic is separable from application traffic at the network level |

## 9. Secrets

- Never in the repository. Environment variables in the platform, or a secret
  manager
- Rotatable without a code change
- Encrypted at rest for anything stored (calendar OAuth tokens, webhook secrets)
- The current `SECRETS_SCAN_OMIT_KEYS` workaround disappears with the hosting
  change; secret scanning stays enabled in CI

## 10. Audit

`audit_logs` is append-only **at the grant level** — the application role has
INSERT and SELECT, never UPDATE or DELETE. Convention is not enough.

Logged: authentication events, permission changes, key and token issuance,
exports, deletions, admin actions, retention purges, feature-flag changes.

Never logged: secrets, passwords, message bodies, document contents, file
contents, AI prompts containing user data.

## 11. Data protection

| | |
|---|---|
| At rest | Postgres and R2 encryption at rest (provider-managed) |
| In transit | TLS everywhere, including internal service hops |
| Backups | Encrypted, 30-day retention, quarterly restore drill |
| Deletion | Two-tier: `deleted_at` trash for 30 days, then hard purge |
| GDPR erasure | A job with a written cascade order; audit rows retain only the actor id |
| Data residency | Single region at launch; not yet a requirement |

## 12. Dependencies

- `pnpm audit` in CI, failing on high severity
- Dependabot with grouped PRs
- Lockfile committed; no floating major versions
- SBOM generated per release

## 13. Verification

| Activity | Cadence |
|---|---|
| Poison-row tenancy suite | Every PR, blocking |
| `pnpm audit` + secret scan | Every PR |
| axe accessibility scan | Every PR |
| Dependency review | Weekly |
| Penetration test | Before enterprise launch, then annually |
| Restore drill | Quarterly |
| `GLOBAL_TABLES` allowlist review | Quarterly |
| Access review | Quarterly |

## 14. Known gaps carried from the current system

Worth fixing on port rather than inheriting:

| Gap | Where | Fix |
|---|---|---|
| `ssl: { rejectUnauthorized: false }` | `api/src/db/client.ts`, `ws/db.ts` | Pin the provider CA rather than disabling verification |
| Auth user lookup caps at 4,000 | `core/supabase-admin.ts` `findAuthUserByEmail` | Direct lookup instead of a paginated scan |
| No error tracking at all | — | Sentry on both ends, from Phase 0 |
| Rate limiting is per-instance | `@fastify/rate-limit` default store | Redis store |
| Whiteboard has no REST write path | `ws/protocol.ts` `board_op` | Add REST write; WS becomes the fast path |
