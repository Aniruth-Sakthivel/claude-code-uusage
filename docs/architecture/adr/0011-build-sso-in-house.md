# 0011 — Build SAML SSO and SCIM in-house

**Status:** Accepted · 2026-08-06
**Supersedes:** the assumption in [0001](0001-hosting-containers.md) and
[05-modules/01-authentication.md](../05-modules/01-authentication.md) that SAML
and SCIM arrive as Supabase configuration

## Context

Enterprise buyers require SAML 2.0 single sign-on and SCIM 2.0 user
provisioning. The original design assumed both would come from Supabase Auth's
enterprise tier — configuration rather than code.

**There is no budget for paid tiers or licensed components.** That constraint is
now fixed, so the question is not "is buying better" but "what does building
cost, and what must change to make it safe."

## Decision

Implement both ourselves, in `apps/api`, on open-source libraries.

**SAML 2.0 Service Provider**

- Our API is the SP; the customer's IdP (Okta, Azure AD, Google Workspace,
  OneLogin) is the IdP
- SP-initiated and IdP-initiated flows
- Per-workspace IdP configuration: entity id, SSO URL, X.509 signing certificate,
  attribute mapping
- Assertion signature verification, `NotBefore`/`NotOnOrAfter` window,
  `Destination` and `Audience` validation, `InResponseTo` correlation, and
  replay prevention via an assertion-id cache
- On successful assertion, mint our own session rather than delegating to
  Supabase — SAML users bypass the password path entirely

Candidate library: `@node-saml/node-saml` (the maintained core of the
passport-saml lineage) or `samlify`. **Verify licence, maintenance status and
open advisories at implementation time** — a stale SAML library is a critical
vulnerability, not an inconvenience.

**SCIM 2.0 Server**

- `/scim/v2/Users` and `/scim/v2/Groups`, with `GET`, `POST`, `PUT`, `PATCH`,
  `DELETE`
- SCIM filter grammar (at minimum `eq`, `and`, `co`, `sw` on `userName`,
  `externalId`, `active`)
- `PATCH` with the SCIM operation semantics (`add`/`remove`/`replace`, including
  the path-expression forms that Azure AD emits)
- Bearer-token authentication with a per-workspace provisioning token, hashed at
  rest
- Deprovisioning sets `is_active = false` and **closes open sessions and
  WebSockets** — a deprovisioned user must lose access in seconds, not at next
  token expiry

Candidate library: `scimmy` for the schema and filter layer. Same verification
requirement.

## Alternatives

**Supabase Auth enterprise tier.** Rejected — no budget. This is the only reason;
it would otherwise be the right call by a wide margin.

**A commercial identity broker (WorkOS, Auth0, Stytch).** Rejected — same reason.
WorkOS in particular exists precisely to sell this six-to-ten week problem as a
configuration step.

**Skip SSO/SCIM entirely.** Rejected: they are enterprise procurement gates.
Without SAML the product cannot be sold to the buyers Phase 6 targets. Deferring
is legitimate; dropping is not.

**OIDC only, no SAML.** Tempting — OIDC is far simpler and Okta, Azure AD and
Google all speak it. **Rejected for v1 scope but explicitly staged**: many
enterprise IdP deployments and their security teams still standardize on SAML,
and it is the one they ask for by name in a security questionnaire. See the
sequencing note below.

## Consequences

- **Phase 6 grows by roughly 8–10 engineer-weeks.** SAML ~4–5 EW, SCIM ~4–5 EW,
  against the ~1 EW that configuration would have cost
- **We now own a security-critical protocol implementation.** SAML has a long
  history of severe vulnerabilities — signature wrapping, XML canonicalization
  bugs, comment-truncation attacks on `NameID`. Consequences that follow:
  - The XML parsing and signature path is reviewed line by line, not skimmed
  - A dependency advisory on the SAML library is a page-immediately alert
  - The implementation is included in the pre-launch penetration test scope, as
    a named target rather than incidental coverage
  - Assertion replay cache is mandatory, not an optimization
- Testing requires real IdPs. A test matrix against Okta developer, Azure AD
  free tier and Google Workspace — all of which have no-cost developer tiers —
  plus SimpleSAMLphp locally in CI
- SCIM semantics are fiddly in practice: Azure AD and Okta disagree on `PATCH`
  path expressions and on how they signal deactivation. Budget time for
  per-provider quirks; this is where the estimate most often slips
- We keep Supabase Auth for password, magic link, OAuth and MFA — all of which
  are on the free tier. Only SAML and SCIM move in-house

## Sequencing

Recommended order within Phase 6, cheapest useful thing first:

1. **OIDC SSO** (~1–2 EW) — covers Okta, Azure AD, Google and most modern IdPs,
   and is a fraction of SAML's cost and risk
2. **SCIM** (~4–5 EW) — provisioning is often the more painful gap for an admin
   than sign-in, and it is independent of which sign-in protocol is used
3. **SAML** (~4–5 EW) — last, because it is the highest risk and the most
   frequently satisfiable by OIDC in practice

If a deal closes on OIDC alone, SAML can be deferred without blocking revenue.
Do not build SAML speculatively.

## Reversal

If budget appears, buying this back is clean and worth doing: the SSO path is
behind one adapter interface, so a broker replaces the SAML and SCIM
implementations without touching principal resolution or the rest of auth.

Reverse if: an enterprise deal requires an IdP we cannot certify against, a
severe advisory lands in the SAML library, or the maintenance burden exceeds
roughly 1 EW per quarter.
