# Module 1 — Authentication and identity

**Phase 0** · ~4 EW

## 1. Objectives

Establish who someone is, and turn that into a `RequestContext` the data layer
can trust. Everything else in the system depends on this being right.

The key decision: **Supabase Auth stays.** It already supplies MFA (TOTP), magic
link, OAuth and SAML SSO — four requirements met by configuration rather than
code. Building any of them ourselves would be a month of work and a permanent
security liability.

## 2. Functional requirements

FR-1 (password / magic link / OAuth / SAML), FR-2 (MFA), FR-3 (sessions and
devices), FR-4 (invitations), FR-5 (custom roles), FR-6 (personal access tokens).

## 3. Non-functional

| | |
|---|---|
| Sign-in latency | p95 < 800ms including principal resolution |
| Token verification | Cached JWKS, no network call on the hot path |
| Session revocation | Effective within 60s, including open WebSockets |
| Password storage | Never touches our database — Supabase holds it |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Sign in | Email + password, magic link, SSO buttons | Sign in |
| Magic link sent | Confirmation, resend with cooldown | — |
| MFA challenge | TOTP entry, recovery code fallback | Verify |
| MFA enrolment | QR + secret, recovery codes shown once | Confirm |
| Forgot password | Email entry | Send reset |
| Reset password | New password, strength meter | Set password |
| Accept invitation | Shows workspace and role, sets password | Join |
| Sessions and devices | Active sessions, last seen, location; revoke | Revoke |
| Personal access tokens | List, create (shown once), revoke | Create |

## 5. User flow — first sign-in via invitation

```
Admin invites → invitation row + email
User clicks   → /invite/:token
              → token validated (unexpired, unused, matches email)
              → Supabase user created or linked
              → workspace_members row created with the invited role
              → invitation marked accepted
              → redirected into the workspace
```

The invitation token is single-use and time-limited. An expired token offers
"request a new invitation" rather than a dead end.

## 6. Database

| Table | Notes |
|---|---|
| `users` | `id`, `supabase_user_id` unique, `email` unique, `full_name`, `avatar_file_id`, `is_active`. **Global** — a user spans workspaces |
| `user_profiles` | Timezone, locale, working hours, `department_id`, `designation_id` |
| `user_sessions` | Mirror of Supabase sessions for the management UI: device, user agent, ip, `last_seen_at`, `revoked_at` |
| `personal_access_tokens` | `token_hash` (sha256), `workspace_id`, `capabilities[]`, `expires_at`, `last_used_at` |
| `invitations` | `workspace_id`, `email`, `role`, `token_hash`, `expires_at`, `accepted_at`, `invited_by` |
| `user_preferences` | Notification settings, density, default view |

`users`, being global, is in `GLOBAL_TABLES` — one of the five tables exempt from
the `workspace_id` requirement, and reviewed quarterly for that reason.

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/auth/config` | Which sign-in methods are enabled |
| POST | `/api/v1/auth/provision` | Idempotently link a Supabase identity to a local user |
| GET | `/api/v1/me` | Principal, capabilities, workspaces |
| GET/PATCH | `/api/v1/me/profile` | |
| GET/PATCH | `/api/v1/me/preferences` | |
| GET | `/api/v1/me/sessions` | Active sessions |
| DELETE | `/api/v1/me/sessions/:id` | Revoke one |
| DELETE | `/api/v1/me/sessions` | Revoke all others |
| GET/POST | `/api/v1/me/tokens` | PATs; secret returned once |
| DELETE | `/api/v1/me/tokens/:id` | Revoke |
| POST | `/api/v1/w/:ws/invitations` | Invite (`manage_members`) |
| POST | `/api/v1/invitations/:token/accept` | Accept |

## 8. Components

`FormCard`, `Field`, `Input`, `Button`, `Alert`, `Table`, `ConfirmDialog`,
`CodeBlock` (recovery codes) — all ported. New: `Avatar`.

## 9. Best practices

- **Verify the JWT against the remote JWKS**, cached at module scope. No shared
  secret ever. Ported from `api/src/core/auth-user.ts`, which already does this
  correctly with `jose`, `audience: "authenticated"` and a 10s clock tolerance.
- **Resolve the principal on every request** — role and membership changes must
  take effect immediately, not at next sign-in. Cache for at most 30s.
- **Token hashes only.** Follow the agent-key pattern in `auth-agent.ts`:
  sha256, `timingSafeEqual` comparison, prefix stored separately for display.
- **Provisioning is idempotent.** A user signing in twice concurrently must not
  create two rows — unique constraint on `supabase_user_id` plus
  `ON CONFLICT DO NOTHING`.

## 10. Security

| Threat | Control |
|---|---|
| Credential stuffing | Rate limit sign-in per IP and per email; Supabase lockout |
| Invitation token brute force | 256-bit token, hashed at rest, single use, 7-day expiry |
| Token replay after revocation | Principal resolution checks `is_active` and membership on every request |
| Privilege escalation via invite | The inviter's own capabilities cap the role they may grant |
| Session fixation | Supabase rotates tokens on sign-in |
| PAT leakage | Shown once, hashed, scoped, expiring, with `last_used_at` for detection |
| Enumeration | Sign-in and forgot-password give identical responses for unknown emails |

**Known scale ceiling to fix on port:** `findAuthUserByEmail` in
`api/src/core/supabase-admin.ts` paginates at 20 × 200 = 4,000 users. Replace the
scan with a direct lookup before that becomes a silent failure.

## 11. Scalability

Principal resolution is two indexed queries per request, cached 30s in Redis. The
JWKS is cached in-process for 10 minutes. Neither scales with user count.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Supabase Auth pricing for SAML/SCIM at the enterprise tier | Verify cost **before** committing to FR-1 at that tier |
| Supabase outage blocks all sign-in | Existing sessions keep working — JWT verification is local against cached JWKS. Only new sign-ins fail |
| Provider lock-in | Auth is behind one adapter interface; principal resolution is ours |
| Session mirror drifts from Supabase | Reconciled on each request; the mirror is display-only, never authoritative |

## 13. Implementation order

1. JWT verification plugin, JWKS caching, principal resolution → `RequestContext`
2. `/auth/provision`, `/me`
3. Invitations: create, accept, expire
4. Sessions and device management
5. PATs
6. MFA enforcement policy per workspace
7. SSO/SAML configuration (deferred to Phase 6)
