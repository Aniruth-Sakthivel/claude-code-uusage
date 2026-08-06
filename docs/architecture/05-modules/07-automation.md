# Module 7 — Automation and integration

**Phase 5** · ~26–32 EW

## 1. Objectives

Let a workspace encode its own process without code, and let other systems
participate. The rule engine exists in the current codebase
(`automation_rules` + `automation_runs`, evaluated in-process); this module moves
it onto the outbox and gives it the filter AST as its condition language.

## 2. Functional requirements

FR-70 (rules), FR-71 (scheduled and approval workflows), FR-72 (webhooks),
FR-73 (public API), FR-74 (import).

## 3. Non-functional

| | Target |
|---|---|
| Rule evaluation | < 500ms from the triggering event |
| Rule throughput | 1,000 events/min without backlog |
| Webhook delivery | First attempt within 5s |
| Import, 50k issues | < 30 min, resumable, with a dry-run report |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Automation list | Rules with trigger, action, enabled, last run | Create rule |
| Rule builder | Trigger → conditions (filter AST) → actions, with a live preview of matches | Save |
| Run history | Per-rule executions, status, detail; failures highlighted | Retry |
| Webhooks | Endpoints, event types, health | Add endpoint |
| Delivery log | Per-delivery status, latency, response body | Replay |
| API tokens | Covered in Module 1 | |
| Import wizard | Source, field mapping, dry-run report, execute | Import |

## 5. User flow — a rule

```
Trigger  : issue.status_changed
Condition: status = done AND type = bug AND label contains "customer"
Actions  : notify reporter · post to #support · set resolved_at
```

The condition is a **filter AST** — the same one the list view and saved views
use. A user can build a filter in the issue list, see exactly which issues match,
then say "automate this". That shared preview is the feature.

## 6. Database

| Table | Notes |
|---|---|
| `automation_rules` | `workspace_id`, `project_id?`, `trigger_type`, `condition` (filter AST as jsonb), `actions jsonb`, `enabled`, `run_count` |
| `automation_runs` | `rule_id` set null, **`rule_name` denormalized** so history survives rule deletion — ported, and correct |
| `webhook_endpoints` | `url`, `secret`, `event_types[]`, `status`, `consecutive_failures` |
| `webhook_deliveries` | Status, latency, response snippet. BRIN on `created_at`, 90-day retention |
| `integrations` | Per-provider config and encrypted credentials |
| `import_jobs` / `export_jobs` | Progress, error report, resumability |

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET/POST/PATCH/DELETE | `/w/:ws/automations` | |
| POST | `/w/:ws/automations/preview` | Which issues match this condition right now |
| POST | `/w/:ws/automations/:id/test` | Dry run against a sample entity |
| GET | `/w/:ws/automations/runs` | |
| GET/POST/PATCH/DELETE | `/w/:ws/webhooks` | |
| POST | `/w/:ws/webhooks/:id/test` | Rate-limited 10/min |
| GET | `/w/:ws/webhooks/:id/deliveries` | |
| POST | `/w/:ws/webhooks/deliveries/:id/replay` | Idempotency-Key required |
| POST | `/w/:ws/imports` | `202` + job id |
| GET | `/api/v1/openapi.json` | Generated from `packages/contracts` |

## 8. Components

`DataGrid`, `Combobox`, `Tabs`, `CodeBlock` (payload preview), `Alert` — mostly
ported. New: a rule-builder composite over the filter-AST editor.

## 9. Best practices

- **Rules run off the outbox**, in the `automation` queue — never inline in the
  request. The current in-process evaluation means a slow rule slows the user's
  save.
- **Loop protection.** An action that triggers a rule that triggers the first
  rule must terminate: a per-event chain depth cap of 5, and a per-rule
  per-entity execution cap of 3 within a minute. Without this, two rules can
  ping-pong an issue forever.
- **Actions performed by an automation are attributed to the rule**, not to a
  user — the activity feed shows "Automation: Close stale bugs", which is what
  makes debugging possible.
- **`rule_name` stays denormalized on runs** so history is readable after the
  rule is deleted.
- **Import runs dry first**, always, producing a report the user approves before
  anything is written.

## 10. Security

| Threat | Control |
|---|---|
| **SSRF via webhook URL** | Egress allowlist — no private ranges, link-local or metadata endpoints. Validated at save **and again at delivery**, because DNS can be re-pointed in between |
| Automation used to escalate privileges | Actions execute with the **rule creator's** capabilities, re-checked at execution time |
| Webhook secret leakage | Stored encrypted, shown once, rotatable |
| Import as an injection vector | Every imported field validated through the same Zod schemas as the API |
| Replay attacks on incoming webhooks | Signed timestamp, 5-minute window |
| Automation as a spam amplifier | Per-workspace execution rate limit |

The SSRF row is the highest-severity item in this module. A webhook endpoint is a
user-controlled URL that our server fetches — the textbook setup.

## 11. Scalability

Rules are indexed by `(trigger_type, enabled)` — ported — so an event evaluates
only candidate rules. Condition evaluation runs in-memory against the event
payload where possible, falling back to a query only when the condition
references data not in the payload.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Automation loops | Chain depth cap, per-entity execution cap, loop detection logged and surfaced |
| Rule builder is too limited, or too complex | Start with the trigger/condition/action triple the current schema already models; extend only on evidence |
| Webhook receivers are slow or dead | 10s timeout, exponential backoff, auto-disable at 100 consecutive failures |
| Import corrupts a workspace | Dry run mandatory; import writes to a staging set committed atomically; full rollback for 24h |
| The public API becomes an unversioned contract | Generated OpenAPI, `/v1` path, 12-month deprecation policy |

## 13. Implementation order

1. Move rule evaluation onto the outbox `automation` queue
2. Filter AST as the condition language + match preview
3. Rule builder UI
4. Run history and retry
5. Loop protection
6. Webhook endpoints, signing, delivery queue
7. Delivery log and replay
8. Generated OpenAPI + docs portal
9. CSV import
10. Jira import (the largest — field, workflow and attachment mapping)
11. Trello and Asana import
