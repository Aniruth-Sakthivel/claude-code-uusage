# Module 4 — Planning: sprints, releases, roadmap

**Phase 2** · ~29–37 EW (Gantt is built in-house — see
[adr/0012](../adr/0012-build-gantt-in-house.md))

## 1. Objectives

Turn a backlog into a commitment, and a commitment into a forecast. This is the
module that separates a task list from a project management system.

Note: `sprints`, `board_columns`, `epics` and the backlog endpoint **already
exist** in the current codebase with full services and REST routes and **zero
frontend**. The backend design is proven; the work here is largely the UI and the
reporting on top.

## 2. Functional requirements

FR-40 (backlog), FR-41 (sprints), FR-42 (milestones, releases), FR-43 (burndown,
burnup, velocity, CFD, cycle time), FR-44 (capacity).

## 3. Non-functional

| | Target |
|---|---|
| Backlog, 5,000 items | Virtualized, 60fps drag |
| Sprint report | < 1s, computed from `entity_versions` |
| Gantt, 500 rows × 12 months | < 1.5s, virtualized rows and windowed dates |
| Burndown accuracy | Reconstructed from history, not recomputed from current state |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Backlog | Ranked list, drag into sprint, inline estimate | Drag to sprint |
| Sprint planning | Capacity bar vs committed points, side-by-side with backlog | Start sprint |
| Active sprint | Board scoped to the sprint, burndown inline | — |
| Sprint report | Completed vs committed, scope change, carry-over | — |
| Velocity | Last N sprints, average, trend | — |
| Milestones | List with due dates, progress, at-risk flag | Create |
| Releases | Version, scope, status, release notes | Cut release |
| **Roadmap** | Quarters × initiatives, drag to reschedule | Drag |
| **Gantt** | Bars, dependencies, critical path | Drag |
| Capacity | Per person: assigned vs available, over-allocation | Reassign |

## 5. User flow — sprint cycle

```
Backlog groomed        → items estimated and ranked
Sprint planning        → drag items in; capacity bar warns on over-commit
Start sprint           → status active (partial-unique index enforces one per project)
                       → a sprint_started snapshot is written for the burndown baseline
During                 → scope changes recorded as entity_versions
                       → burndown recomputed from history, never from current state
Complete sprint        → incomplete items → next sprint or back to backlog
                       → sprint report generated
```

The burndown detail matters: computing it from current state makes scope added
mid-sprint invisible, which is exactly what a burndown exists to reveal.

## 6. Database

`sprints` (`workspace_id`, `project_id`, `name`, `goal`, `start_date`,
`end_date`, `status`), `milestones`, `releases`, `issue_dependencies`
(`blocks` / `blocked_by`, with a cycle check), `sprint_snapshots` (daily
remaining points, so history survives issue deletion).

Ported pattern — one active sprint per project, enforced by the database rather
than by application care:

```sql
CREATE UNIQUE INDEX ON sprints (project_id) WHERE status = 'active';
```

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/w/:ws/projects/:key/sprints` | |
| GET/PATCH/DELETE | `/w/:ws/sprints/:id` | |
| POST | `/w/:ws/sprints/:id/start` · `/complete` | State transitions |
| GET | `/w/:ws/projects/:key/backlog` | Cursor-paginated, ranked |
| GET | `/w/:ws/sprints/:id/burndown` · `/report` | |
| GET | `/w/:ws/projects/:key/velocity` | |
| GET/POST | `/w/:ws/projects/:key/{milestones,releases}` | |
| GET/POST/DELETE | `/w/:ws/issues/:key/dependencies` | Cycle-checked |
| GET | `/w/:ws/roadmap` · `/gantt` | |
| GET | `/w/:ws/capacity` | Assigned vs available |

## 8. Components

New: `GanttChart`, `Timeline`. Reused: `KanbanBoard`, `DataGrid`, `DatePicker`,
`Stat`, `Tabs`, and the ported `TimeseriesChart` for burndown and velocity.

## 9. Best practices

- **Reconstruct burndown from `entity_versions`**, never from current state.
- **Dependency cycles are rejected at write time** with a graph check — a cycle
  makes the critical path undefined and Gantt unrenderable.
- **Capacity is advisory.** Warn on over-commitment; never block. Teams have
  reasons.
- **Completing a sprint is explicit** about where incomplete items go, presented
  as a choice rather than a silent default.

## 10. Security

Standard project scoping. One module-specific concern: sprint reports aggregate
across a project, so a user with partial project access must not see totals that
include issues hidden from them — aggregates are computed **after** scoping, not
before.

## 11. Scalability

Burndown reads `sprint_snapshots` (one row per sprint per day), not the full
history — bounded regardless of issue count. Gantt windows the visible date range
and virtualizes rows. Critical path is computed in the worker and cached for
projects over 500 issues.

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Gantt overruns, with no purchase fallback** — genuinely 4–8 weeks elsewhere | Budgeted at 5–6 EW and staged, so Stage 1 (read-only) ships independently and Stages 3–5 are deferrable. Reverse-check if Stage 1 alone exceeds 3 EW. See [adr/0012](../adr/0012-build-gantt-in-house.md) |
| Burndown disagrees with what people remember | Computed from history; the sprint report shows scope-change events explicitly |
| Dependency graph becomes unrenderable | Cap dependency depth at 10; collapse chains visually beyond that |
| Roadmap and Gantt become two implementations of one thing | Roadmap is a coarse Gantt over the same component with a quarter timescale |

## 13. Implementation order

1. Backlog view + ranking (reuses LexoRank from Module 3)
2. Sprint CRUD, start/complete, one-active constraint
3. Sprint planning with the capacity bar
4. `sprint_snapshots` + burndown + velocity
5. Sprint report
6. Milestones and releases
7. Dependencies with cycle detection
8. Gantt Stage 1 — read-only timescale, bars, zoom, virtualized rows
9. Gantt Stage 2 — dependency arrows
10. Roadmap (reuses the Gantt timescale core at quarter zoom)
11. Gantt Stage 3 — drag to move and resize
12. Capacity planning (reuses the same core)
13. Gantt Stages 4–5 — critical path, baseline, export. **Deferrable**
