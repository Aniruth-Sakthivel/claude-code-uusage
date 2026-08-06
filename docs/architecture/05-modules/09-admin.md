# Module 9 — Administration

**Phase 6** · ~28–35 EW (SSO and SCIM are built in-house — see
[adr/0011](../adr/0011-build-sso-in-house.md))

## 1. Objectives

Give operators what they need to run the system, and give auditors what they need
to trust it. This module is boring until the moment it is the only thing that
matters.

Note on scope: the requirement list asked for both an admin panel and a
super-admin panel over organizations. With **one organization**, those collapse
into one. The org-level screens are designed so a future multi-org split adds a
tier above rather than restructuring what exists.

## 2. Functional requirements

FR-90 (audit log, export, retention), FR-91 (feature flags), FR-92 (storage
usage and quota), FR-93 (health, queue depth, failed-job replay), plus MFA
policy, SSO/SCIM and session management from Module 1.

## 3. Non-functional

| | Target |
|---|---|
| Audit query, 2 years | Cursor-paginated, < 1s |
| Audit export | Async, signed link, tamper-evident |
| Health endpoint | < 50ms, never touches the database (`/live`) |
| Feature flag change | Effective within 30s |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Org dashboard | Workspaces, users, storage, activity | — |
| Workspaces | List, owner, size, created; archive | Archive |
| Users | All users across workspaces, status, last active | Deactivate |
| Audit log | Filterable by actor, action, target, date | Export |
| Feature flags | Per-flag: off / on / percentage / allowlist | Toggle |
| Storage | Per workspace: used, quota, largest files | Set quota |
| **Queues** | Bull Board: depth, failed jobs, replay | Replay |
| System health | DB, Redis, R2, queue depth, error rate | — |
| Email log | Delivery status, bounces, complaints | Resend |
| Security policy | MFA enforcement, session timeout, SSO config | Save |
| Retention policy | Per data type, with a purge preview | Apply |

## 5. User flow — investigating an incident

```
Report: "someone deleted a project"
  → Audit log, filter action = project.deleted
  → Actor, timestamp, ip, user agent
  → Target project id → entity_versions for the full pre-delete state
  → deleted_at is within 30 days → restore from trash
  → Restore is itself audited
```

The two-tier soft delete is what makes this recoverable rather than a
restore-from-backup exercise.

## 6. Database

| Table | Notes |
|---|---|
| `audit_logs` | `actor_user_id` (no FK — rows survive user deletion, ported decision), `actor_email`, `action`, `target`, `detail`, `ip`, `user_agent`, `at`. **Append-only: no UPDATE or DELETE grant** |
| `feature_flags` | `key`, `enabled`, `rollout_percentage`, `allowed_workspace_ids[]` |
| `storage_usage` | Per workspace, rolled up nightly |
| `retention_policies` | Per data type, per workspace |
| `email_log` | Provider id, status, bounce reason |

`audit_logs` deliberately has no foreign key on the actor. A deleted user must
not take their audit trail with them — the current schema already gets this right
(`schema.ts:757`).

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/admin/audit` | `view_audit`, filterable, cursor-paginated |
| POST | `/api/v1/admin/audit/export` | Async, signed link |
| GET/PATCH | `/api/v1/admin/feature-flags` | |
| GET | `/api/v1/admin/storage` | Per-workspace usage |
| PATCH | `/api/v1/admin/workspaces/:id/quota` | |
| GET | `/api/v1/admin/health` | Dependency status |
| GET | `/api/v1/admin/metrics` | `view_audit` |
| `*` | `/admin/queues` | Bull Board, `view_audit` |
| GET/PATCH | `/api/v1/admin/security-policy` | |
| GET/PATCH | `/api/v1/admin/retention` | |
| POST | `/api/v1/admin/retention/purge` | Explicit, audited, with a preview |

Port the health probe split from `api/src/index.ts`: `/live` must **never** touch
the database, or a slow query takes down every pod at once.

## 8. Components

`Table`, `DataGrid`, `Badge`, `StatusPill`, `ConfirmDialog`, `Alert`, `Stat`,
`Tabs`, `DateRangePicker` — all ported or already planned.

## 9. Best practices

- **Audit is append-only at the grant level**, not by convention. The
  application role has INSERT and SELECT, never UPDATE or DELETE.
- **Never log secrets, prompts, message bodies or file contents.** The current
  schema states this as a comment; make it a review checklist item.
- **Purge is explicit and previewed.** Show what will be deleted and how many
  rows before doing it. The current implementation already requires an operator
  action rather than running silently, which is the right instinct.
- **Feature flags are read through one helper** with a 30s cache, so a flag can
  be turned off during an incident without a deploy.
- **Every admin action is audited, including reads of sensitive data** — who
  exported the audit log is itself audit-worthy.

## 10. Security

| Threat | Control |
|---|---|
| Audit log tampering | No UPDATE/DELETE grant; exports include a checksum |
| Admin panel as a privilege escalation path | Every route gated on a specific capability, never a generic "is admin" |
| Data exfiltration via export | `export` capability, rate-limited, audited, signed links expiring in 15 min |
| Feature flag abuse | Flag changes are audited; security-relevant flags require two-person approval |
| Queue admin exposing payloads | Bull Board behind `view_audit`; job payloads redact user content |

## 11. Scalability

`audit_logs` is append-only with a BRIN index on `at` and monthly partitions past
50M rows. Exports stream to R2 rather than buffering. Storage rollups run
nightly, never on demand.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Audit log growth outruns the primary | BRIN + partitioning + 2-year retention with export before purge |
| Admin panel becomes a second product | Scoped to what on-call actually needs, informed by the runbook |
| Feature flags accumulate forever | Every flag has an owner and a removal date; a stale-flag report runs monthly |
| Retention purge deletes something needed | Preview + confirmation + a 30-day trash tier before hard delete |
| Single-org assumption leaks into the UI | Org screens are built as if there could be several, even though there is one |

## 13. Implementation order

1. `audit_logs` with append-only grants, and the write helper
2. Audit log UI with filters
3. Health and metrics endpoints, `/live` and `/ready` split
4. Bull Board + failed-job replay
5. Feature flags + the read helper
6. Storage rollups and quotas
7. Retention policies with preview and purge
8. Security policy: MFA enforcement, session timeout
9. Audit export with checksum
10. OIDC SSO configuration UI
11. SCIM provisioning: token issuance, sync status, last-provisioned view
12. SAML IdP configuration UI: entity id, SSO URL, certificate upload,
    attribute mapping, metadata download, test-connection

Items 10–12 are configuration surfaces over the in-house implementations in
Module 1 — see [adr/0011](../adr/0011-build-sso-in-house.md).
