# Database design

Postgres 15+. Drizzle ORM. All SQL confined to `packages/db/src/repositories/**`.

## 1. Conventions

| Convention | Choice | Why |
|---|---|---|
| Primary key | `uuid` holding **UUIDv7** | Time-ordered, so index locality without leaking business volume. Identity ints leak counts, block client-generated ids (which optimistic creates need), and make import/merge painful |
| Human key | `issues.key` = `ENG-142` | From `project_counters.next_number`, incremented in the same transaction. Users never see UUIDs |
| Timestamps | `timestamptz`, always | |
| Concurrency | `version integer NOT NULL DEFAULT 1` on every editable entity | Powers `If-Match` and realtime reconciliation |
| Enum-ish columns | `varchar` + Zod, **not** PG enums | Ported decision. PG enums cannot be altered transactionally and this schema will churn |
| Scope | `workspace_id NOT NULL` on every tenant table | See [03-tenancy.md](03-tenancy.md) |
| Uniqueness | Always workspace-scoped and partial: `UNIQUE (workspace_id, slug) WHERE deleted_at IS NULL` | |

`updated_at` is maintained in the repository layer, not by a trigger — triggers
fight optimistic-concurrency versioning and cannot see the acting user.

## 2. Tables by module

**Tenancy and identity**
`organizations`, `workspaces`, `workspace_members`, `users`, `user_profiles`,
`teams`, `team_members`, `invitations`, `user_sessions`,
`personal_access_tokens`, `user_preferences`

**Directory**
`departments`, `designations`, `skills`, `user_skills`, `user_availability`

**Projects**
`projects`, `project_members`, `project_counters`, `milestones`, `sprints`,
`releases`, `modules`, `board_columns`, `workflows`, `workflow_transitions`

**Work items**
`issues`, `issue_links`, `issue_dependencies`, `issue_watchers`, `labels`,
`issue_labels`, `issue_comments`, `comment_reactions`, `issue_templates`,
`recurrence_rules`

**Custom data**
`custom_field_defs`, `custom_field_index`

**Time**
`time_entries`, `timesheets`, `timesheet_approvals`, `estimates_history`

**Files**
`files`, `file_links`, `file_versions`

**Collaboration**
`docs`, `doc_versions`, `channels`, `channel_members`, `chat_messages`,
`message_reads`, `message_reactions`, `whiteboards`, `whiteboard_elements`,
`meetings`, `meeting_attendees`, `calendar_connections`

**Automation and integration**
`automation_rules`, `automation_runs`, `webhook_endpoints`,
`webhook_deliveries`, `integrations`, `import_jobs`, `export_jobs`

**Notification**
`notifications`, `notification_preferences`, `email_log`, `push_subscriptions`

**System**
`outbox_events`, `activity`, `entity_versions`, `audit_logs`,
`search_documents`, `saved_views`, `idempotency_keys`, `feature_flags`,
`app_settings`

## 3. Key modelling decisions

### 3.1 One `issues` table with a `type` discriminator

`type ∈ {task, bug, story, epic, subtask, spike}`, replacing the current
`tasks` + `epics` split.

- Epics become `type='epic'` with children via `parent_id`.
- **Bug tracking falls out for free**: a bug is `type='bug'` with a bug-specific
  `board_columns` set on the project, and severity / environment / reproduction
  steps as custom fields. No second table, no second board engine, no second
  permission path.
- "Everything in this project" is one query, not a UNION.

This is what Jira and Linear both do, and for the same reason.

**`milestones` and `sprints` stay separate tables.** They are dated containers,
not work items. Giving them issue semantics produces nonsense — a sprint with an
assignee and a story point estimate.

### 3.2 Ranking: LexoRank strings, not integer positions

```
issues.rank varchar(64) NOT NULL     -- e.g. "0|hzzzzz:", "0|i00007:"
```

A drag is a **single-row UPDATE** computing the midpoint string between its two
new neighbours. No reindexing of the column, no float precision exhaustion, no
write amplification when thirty people drag simultaneously.

A nightly worker rebalances any board whose ranks exceed 12 characters.

The existing `board_columns.position integer` pattern is fine for eight columns.
It is not fine for 5,000 cards: reordering with integer positions rewrites every
row after the insertion point, and two concurrent drags lose one of the updates.

### 3.3 Custom fields: JSONB, not EAV

```
issues.custom_fields jsonb NOT NULL DEFAULT '{}'
custom_field_defs(workspace_id, project_id?, key, type, options,
                  required, default_value, is_filterable)
```

Rendering a 500-row list view with 8 custom fields costs **4,000 extra rows and
a pivot** in EAV. In JSONB it is one column already in the heap tuple. EAV also
turns every write into a multi-row transaction.

The known JSONB weakness — filtering and sorting — is handled explicitly rather
than hand-waved:

- `GIN (custom_fields jsonb_path_ops)` for containment and existence filters.
- Fields flagged `is_filterable` are **additionally** projected by trigger into
  a narrow table:

```
custom_field_index(workspace_id, entity_id, field_def_id,
                   text_value, num_value, date_value, bool_value)
```

  with real btree indexes on `(workspace_id, field_def_id, num_value)` and the
  text/date equivalents. Sorting and range-filtering hit that table; display
  reads the JSONB.

- Hard cap of **10 filterable fields per project**, so the index table stays
  bounded. The API returns `400` when asked to sort by a non-filterable field —
  a clear error beats a slow `200`.

### 3.4 Soft delete: two tiers, deliberately distinct

| Column | Meaning | Visibility |
|---|---|---|
| `archived_at` | A **product** concept — done with, but real | Visible in "Archived" views, restorable, counts in historical reports |
| `deleted_at` | **Trash** | Hidden by `scoped()` everywhere, restorable for 30 days, then hard-purged by the retention worker |

Consequence to get right at the start: **every unique index must be partial**,
`WHERE deleted_at IS NULL`. Otherwise a user can never reuse the slug or key of
a deleted project — a bug that is trivial now and a migration later.

Hard delete is reserved for GDPR erasure and runs as a job with a written
cascade order.

### 3.5 Three audit streams

The current repo already got the core insight right — `pm_activity` is
deliberately not `audit_logs` (`api/src/db/schema.ts:516`). Extend to three:

| Stream | Purpose | Volume | Retention |
|---|---|---|---|
| `audit_logs` | Security and compliance: admin actions, permission changes, key issuance, exports. Append-only, no UPDATE grant | Low | 2 years, exportable |
| `activity` | Product surface. Polymorphic `(entity_type, entity_id)`. Powers Activity tabs, digests, recently-viewed | Very high | 12 months. BRIN on `created_at`; monthly range partitions past 50M rows |
| `entity_versions` | Field-level history: `{entity_type, entity_id, version, actor_id, changes jsonb, created_at}` | Medium | Forever for docs; 12 months of deltas for issues |

Docs store **full body snapshots** (diff and restore need them); issues store
**field deltas** only.

All three are written from the outbox by one `recordChange()`, **never by
database triggers** — a trigger cannot cleanly see the acting user, cannot be
typed, and cannot be unit-tested.

### 3.6 The outbox

```
outbox_events(
  id            bigserial primary key,   -- monotonic; clients replay from here
  workspace_id  uuid not null,
  event_type    varchar(64) not null,
  entity_type   varchar(32) not null,
  entity_id     uuid not null,
  version       integer not null,
  payload       jsonb not null,
  actor_id      uuid,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
)
```

`bigserial`, not UUID, because consumers and reconnecting clients need a total
order they can express as "everything after N".

Index: `(processed_at, id) WHERE processed_at IS NULL` — the dispatcher's only
query, and it stays tiny because processed rows drop out of the partial index.

## 4. Indexing strategy

1. **Every composite index leads with `workspace_id`.** Lint-enforced.
2. **Partial by default:** `WHERE deleted_at IS NULL` — smaller index, and it
   matches the query `scoped()` actually emits.
3. Named hot paths:

| Query | Index |
|---|---|
| Board | `(workspace_id, project_id, status, rank) INCLUDE (title, assignee_id, priority, type)` — index-only scan for the whole card payload |
| My work | `(workspace_id, assignee_id, status, due_date) WHERE deleted_at IS NULL` |
| Recents / sync | `(workspace_id, updated_at DESC)` |
| Comments | `(issue_id, created_at)` |
| Notifications | `(user_id, read_at, created_at)` — ported as-is; it is correct |
| Outbox drain | `(processed_at, id) WHERE processed_at IS NULL` |

4. `GIN (search_vector)` on `search_documents`; `GIN (title gin_trgm_ops)` on
   `issues` for typeahead.
5. `BRIN (created_at)` on `activity` and `webhook_deliveries` — append-only,
   time-correlated, ~1000× smaller than btree.
6. Partial unique for at-most-one invariants, porting the good
   `system_account_bindings_open_idx` pattern (`schema.ts:845`):
   `UNIQUE (project_id) WHERE status = 'active'` for the active sprint.
7. `pg_stat_statements` enabled from day one. A weekly job flags any query over
   100ms p95 without a supporting index.

## 5. Partitioning

Not at launch. Prepared for:

| Table | Trigger | Scheme |
|---|---|---|
| `activity` | >50M rows | Monthly range on `created_at` |
| `webhook_deliveries` | >20M rows | Monthly range, 90-day drop |
| `outbox_events` | Never — drained and purged | |
| `notifications` | >50M rows | Monthly range |

## 6. Migrations

**Expand-contract, always.** Never a destructive change in the same release that
stops using the column:

```
1. Add the new column, nullable                    (deploy N)
2. Backfill in a job, in batches                   (deploy N)
3. Dual-write old and new                          (deploy N)
4. Switch reads to new                             (deploy N+1)
5. Stop writing old                                (deploy N+1)
6. Drop old                                        (deploy N+2)
```

Every migration must be backward-compatible with the currently-running image,
because pods roll gradually. A migration that breaks the old code causes a
partial outage for the duration of the rollout.

CI runs every migration forward **and** backward against a restored
production-shaped dump.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Custom fields destroy list-view performance | Filterable cap, separate index table, `EXPLAIN` assertions in CI for the top 20 query shapes, 400 on unsupported sorts |
| Rank corruption under concurrent drags | LexoRank + `If-Match` + nightly rebalance + a property test applying 10,000 random concurrent moves and asserting unique total order |
| `activity` growth outruns the primary | BRIN, partitioning trigger at 50M, 12-month retention |
| A unique index blocks slug reuse after delete | Partial-unique enforced by schema lint |
| Model churn once real users arrive | Expand-contract; feature flags so half-built models ship dark; quarterly restore drill |
| Outbox becomes a hot spot | Partial index on unprocessed rows; `FOR UPDATE SKIP LOCKED`; purge processed rows after 7 days |
