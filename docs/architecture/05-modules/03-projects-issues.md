# Module 3 — Projects and issues

**Phase 1** · ~32–40 EW · the largest module, and the product

## 1. Objectives

The core loop: create work, organize it, move it, discuss it, finish it. If this
module is good the product is viable; if it is slow or awkward nothing else
compensates.

## 2. Functional requirements

FR-20 through FR-30 — projects, issues of six types, custom workflows, subtasks,
dependencies, labels, priority, points, custom fields, templates, recurrence,
five view types, saved views, bulk edit, attachments.

## 3. Non-functional

| | Target |
|---|---|
| Board, 2,000 cards | p95 < 1.0s to interactive |
| List, 10,000 rows | 60fps scroll |
| Drag commit | One round trip, optimistic, < 200ms perceived |
| Issue detail open | < 300ms (prefetched on hover) |
| Bulk edit, 500 issues | < 5s, partial-success reporting |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Project list | All projects, health, progress, lead | Create project |
| Project header | Key, name, lead, view tabs, filter bar | Switch view |
| **Board** | Virtualized Kanban, custom columns, WIP limits, swimlanes | Drag |
| **List** | DataGrid: sort, group, inline edit, multi-select | Bulk edit |
| **Calendar** | Due dates by month/week | Drag to reschedule |
| **Timeline** | Issues as bars over dates | — |
| Issue detail | Modal over the list, full page from a deep link | Edit |
| Issue create | Quick-add inline; full modal for detail | Create |
| Bulk edit bar | Appears on selection; count + actions | Apply |
| Filter bar | Chips per active filter; save as view | Save view |
| Saved views | Personal and shared, per project | Open |
| Project settings | Columns, workflow, custom fields, members, templates | Save |

## 5. User flow — the core loop

```
Open project → board view, filters restored from URL
Quick-add    → title only, optimistic card appears immediately
Drag card    → LexoRank midpoint computed client-side
             → optimistic move
             → PATCH with If-Match
             → outbox → everyone else's board updates live
Open issue   → prefetched on hover, so it is already warm
Comment      → @mention → notification to the mentioned user
Mark done    → automation may fire (e.g. move to Done, notify reporter)
```

## 6. Database

Central decision, argued in [../10-database.md](../10-database.md): **one
`issues` table with a `type` discriminator**.

```
issues(
  id uuid pk,               workspace_id, project_id,
  key varchar,              -- ENG-142, from project_counters
  type varchar,             -- task|bug|story|epic|subtask|spike
  parent_id uuid,           -- subtasks and epic children
  title, description,
  status varchar,           -- a board_columns.key
  priority varchar,         -- low|medium|high|urgent
  story_points integer,     estimate_minutes integer,
  assignee_id, reporter_id, milestone_id, sprint_id, release_id,
  rank varchar,             -- LexoRank
  custom_fields jsonb,
  due_date date, start_date date,
  version integer,
  archived_at, deleted_at, created_at, updated_at
)
```

Supporting: `projects`, `project_members`, `project_counters`, `board_columns`,
`workflows`, `workflow_transitions`, `issue_links`, `issue_dependencies`,
`issue_watchers`, `labels`, `issue_labels`, `issue_comments`,
`comment_reactions`, `issue_templates`, `recurrence_rules`,
`custom_field_defs`, `custom_field_index`, `files`, `file_links`, `saved_views`.

Hot-path index — an index-only scan for the entire card payload:

```sql
CREATE INDEX ON issues (workspace_id, project_id, status, rank)
  INCLUDE (title, assignee_id, priority, type)
  WHERE deleted_at IS NULL;
```

**Bug tracking needs no separate table.** A bug is `type='bug'` with a
bug-specific column set on the project, and severity / environment /
reproduction steps as custom fields.

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/w/:ws/projects` | |
| GET/PATCH/DELETE | `/w/:ws/projects/:key` | |
| GET/POST/PATCH/DELETE | `/w/:ws/projects/:key/columns` | Custom workflow |
| GET | `/w/:ws/issues` | Filter AST, cursor-paginated, `?fields=` projection |
| POST | `/w/:ws/issues` | |
| GET/PATCH/DELETE | `/w/:ws/issues/:key` | PATCH requires `If-Match` |
| POST | `/w/:ws/issues/bulk` | Selection or filter selector |
| POST | `/w/:ws/issues/:key/rank` | Move: `{beforeId, afterId}` → server validates the rank |
| GET/POST | `/w/:ws/issues/:key/comments` | Clients may comment |
| POST/DELETE | `/w/:ws/issues/:key/labels` | |
| POST/DELETE | `/w/:ws/issues/:key/watchers` | |
| GET/POST/DELETE | `/w/:ws/issues/:key/links` | Relations and dependencies |
| POST | `/w/:ws/issues/:key/attachments` | Presigned R2 upload |
| GET/POST/PATCH/DELETE | `/w/:ws/saved-views` | |
| GET/POST/PATCH/DELETE | `/w/:ws/custom-fields` | |
| GET/POST | `/w/:ws/projects/:key/templates` | |

## 8. Components

New and expensive: `KanbanBoard`, `DataGrid`, `RichTextEditor`, `Combobox`,
`DatePicker`, `FileDropzone`, `Tabs`.
Ported: `Card`, `Badge`, `Modal`, `Table`, `EmptyState`, `Button`, `Field`.

## 9. Best practices

- **Ranking is client-computed.** The drop knows its neighbours, so it computes
  the midpoint and sends one PATCH. No round trip to ask where the card landed.
- **The filter AST is shared** with saved views, automation and bulk selection.
  One parser. Three implementations is how "the view shows it but the automation
  didn't fire" happens.
- **Quick-add is optimistic with a client-generated UUIDv7** — this is precisely
  why the PK is a UUID rather than an identity integer.
- **`status` stores a `board_columns.key`**, validated in the service layer
  against that project's columns, not by a global Zod enum. Ported decision;
  custom workflows depend on it.
- **Bulk operations chunk at 100** and return partial success.

## 10. Security

| Threat | Control |
|---|---|
| Reading an issue in another project | Project scope in `scopeProjects`; 404 not 403 |
| A client-role user reaching workspace-wide issue search | `requireStaff` at the route **and** an empty project scope at the data layer |
| Custom-field sort used for a table scan (DoS) | Only `is_filterable` fields are sortable; otherwise 400 |
| Attachment path traversal / content sniffing | Presigned PUT to a generated key; `Content-Disposition: attachment`; served from a separate origin |
| Bulk edit escalation | Every id re-checked against scope inside the chunk transaction |
| Stored XSS via description or comment | Markdown/TipTap output sanitized server-side on write and escaped on render |

## 11. Scalability

| Concern | Approach |
|---|---|
| 2,000-card board | Per-column virtualization; the `INCLUDE` index makes the payload an index-only scan |
| 10M issues | Cursor pagination, all indexes workspace-first, no offset |
| Concurrent drags | LexoRank single-row updates + `If-Match`; nightly rebalance |
| Custom-field filtering | Separate typed index table, capped at 10 filterable fields |
| Comment threads in the thousands | Cursor-paginated, newest-first, "load earlier" |

## 12. Risks

| Risk | Mitigation |
|---|---|
| Board performance misses NFR-1 | Seeded 2,000-card fixture in CI with a Playwright timing assertion from week one |
| Rank corruption under concurrency | Property test: 10,000 random concurrent moves, assert unique total order preserved |
| `DataGrid` becomes a second product | Built on TanStack Table; scope written before starting |
| Custom fields degrade every list query | `EXPLAIN` assertions in CI for the top 20 query shapes |
| One `issues` table becomes a god table | Type-specific behaviour lives in services, not columns; per-type validation from `custom_field_defs` |
| Workflow rules become a rules engine | v1 is column order + optional transition restrictions. Not a BPMN engine |

## 13. Implementation order

1. `projects`, `project_members`, `project_counters`, `board_columns`
2. `issues` CRUD, key generation, `version` + `If-Match`
3. Filter AST parser (shared package) + list endpoint
4. `DataGrid` list view
5. LexoRank + `KanbanBoard` + drag
6. Issue detail, comments, mentions, watchers
7. Labels, priority, points, due dates
8. Attachments (R2 + `files` worker)
9. Realtime on board and issue
10. Saved views
11. Bulk operations
12. Custom fields + filterable index
13. Subtasks, dependencies, links
14. Templates and recurrence
15. Calendar and timeline views
