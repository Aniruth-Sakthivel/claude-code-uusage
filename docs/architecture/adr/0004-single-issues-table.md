# 0004 — One `issues` table with a type discriminator

**Status:** Accepted · 2026-08-06

## Context

The product needs tasks, bugs, stories, epics, subtasks and spikes. The current
schema models tasks and epics as separate tables (`tasks`, `epics`), with
`tasks.epic_id` linking them.

The requirements also ask for a bug-tracking module with its own severity,
environment, reproduction steps and resolution workflow.

## Decision

One `issues` table with `type ∈ {task, bug, story, epic, subtask, spike}`.

- Epics are `type='epic'` with children via `parent_id`
- Subtasks are `type='subtask'` with `parent_id`
- **Bugs need no separate table**: `type='bug'`, a bug-specific `board_columns`
  set on the project, and severity / environment / reproduction as custom fields

`milestones` and `sprints` stay separate tables.

## Alternatives

**Separate table per type.** Rejected:

- "Everything in this project" becomes a UNION across six tables
- Every cross-type feature — search, filters, saved views, bulk edit, activity,
  notifications, automation — needs six code paths
- Converting a task to a bug becomes a delete plus an insert, losing history,
  comments and the issue key
- Six sets of indexes, six permission paths, six realtime subscriptions

**Single table with type-specific side tables** (`issues` + `bug_details`).
Rejected: a left join on every read for fields that are conceptually just
attributes, and it reintroduces the type-specific code paths for writes.

**Everything as an issue, including sprints and milestones.** Rejected — that is
the mistake in the other direction. A sprint with an assignee and a story-point
estimate is nonsense. They are dated containers, not work items.

## Consequences

- `issues` is a wide table with columns not meaningful for every type
  (`story_points` on a spike). Acceptable — they are nullable and cheap
- Type-specific validation lives in the service layer, driven by
  `custom_field_defs`, rather than in the schema
- Risk of becoming a god table. Mitigated by keeping type-specific *behaviour* in
  services, and type-specific *fields* in `custom_fields`
- One set of indexes, one permission path, one realtime subscription, one filter
  language. This is the whole point
- Type conversion is an `UPDATE`, preserving key, history and comments

Both Jira and Linear model it this way, for these reasons.

## Reversal

If one type grows genuinely divergent storage requirements — say, a bug needing
structured crash dumps in the tens of megabytes — move that payload to a side
table or object storage. That is an additive change, not a re-split of `issues`.
