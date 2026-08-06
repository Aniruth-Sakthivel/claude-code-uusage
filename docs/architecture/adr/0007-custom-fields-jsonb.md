# 0007 — JSONB custom fields with a narrow filterable index

**Status:** Accepted · 2026-08-06

## Context

Workspaces need to add their own fields to issues — severity, environment,
customer, contract value. These must be displayable in a 500-row list view,
filterable, and sortable.

## Decision

```
issues.custom_fields jsonb NOT NULL DEFAULT '{}'
custom_field_defs(workspace_id, project_id?, key, type, options,
                  required, default_value, is_filterable)
```

`GIN (custom_fields jsonb_path_ops)` for containment and existence.

Fields flagged `is_filterable` are **additionally** projected by trigger into a
narrow typed table:

```
custom_field_index(workspace_id, entity_id, field_def_id,
                   text_value, num_value, date_value, bool_value)
```

with real btree indexes. Sorting and range filtering hit that table; display
reads the JSONB.

**Hard cap of 10 filterable fields per project.**

## Alternatives

**EAV (`custom_field_values` row per field per entity).** Rejected:

- Rendering 500 rows with 8 custom fields reads **4,000 extra rows** and requires
  a pivot
- Every issue write becomes a multi-row transaction
- The value column is either `text` (losing type-correct sorting — "10" sorts
  before "9") or one column per type (which is what `custom_field_index` already
  is, minus the display cost)

**A column per custom field, added by DDL.** Rejected: user-triggered DDL on a
100M-row table, unbounded column count, migration chaos, and a schema that
differs per workspace.

**JSONB only, no index table.** Rejected. This is the tempting shortcut and the
reason custom fields destroy performance in so many products: `ORDER BY
custom_fields->>'severity'` cannot use a btree index and table-scans 500k rows.
The `GIN jsonb_path_ops` index helps containment but not sorting or ranges.

**A document database for issues.** Rejected: loses transactions, joins, and the
tenancy guard the whole architecture depends on.

## Consequences

- The trigger maintaining `custom_field_index` adds write cost, bounded by the
  10-field cap
- Two sources for the same value — JSONB (authoritative) and the index table
  (derived). A reconciliation job checks for drift
- **The API returns `400` when asked to sort by a non-filterable field.** An
  honest error beats a query that table-scans and times out
- Marking a field filterable backfills the index table as a job, not inline
- The 10-field cap is a product constraint users will occasionally hit. It is
  visible and explained rather than silent

## Verification

`EXPLAIN` assertions in CI for the top 20 list-view query shapes, run against
the 500k-issue fixture. A plan degrading from index scan to sequential scan
fails the build.

## Reversal

If the 10-field cap proves too tight, raise it and measure — the design does not
break, it just costs more per write. A cap of 25 is likely still fine; the point
is that it is bounded and measured rather than unbounded and hoped-for.

Moving to EAV would be a regression, not a reversal.
