# 0012 — Build the Gantt chart in-house

**Status:** Accepted · 2026-08-06
**Supersedes:** the "price commercial components before Phase 2" mitigation in
the original Phase 2 risk register

## Context

The roadmap requires a Gantt/timeline view: dated bars, dependency arrows,
drag-to-reschedule, and 500+ rows over a 12-month window.

The original plan timeboxed a build at three weeks with commercial components
(Bryntum, DHTMLX, Syncfusion) priced in advance as the fallback.

**There is no budget for licences.** The fallback does not exist, so the timebox
was protecting nothing.

## Decision

Build it, on `packages/ui/GanttChart`, with an explicitly staged scope and a
realistic budget of **5–6 engineer-weeks** rather than a three-week timebox that
would only have produced pressure.

Technical approach:

| Concern | Approach |
|---|---|
| Timescale | CSS Grid columns, one per day/week/month depending on zoom |
| Bars | Absolutely positioned within the grid, `transform` for drag (never layout) |
| Dependencies | **One** SVG overlay for all arrows, not one SVG per arrow |
| Rows | `@tanstack/react-virtual` — the same virtualizer the DataGrid uses |
| Dates | Windowed to the visible range plus one screen of buffer |
| Drag/resize | Pointer events, snapping to the timescale unit, optimistic + `If-Match` |
| Critical path | Computed in the worker and cached for projects over 500 issues |

Reuses what already exists rather than starting fresh: the virtualizer from the
DataGrid, the LexoRank and `If-Match` machinery from the board, the chart colour
tokens (`--pc1..--pc5`) from the ported theme, and dnd-kit's pointer sensors.

## Staged scope

Each stage ships independently and is useful on its own. This is what protects
the schedule now that there is no fallback.

| Stage | Scope | EW |
|---|---|---|
| **1** | Read-only: timescale, bars, zoom (day/week/month/quarter), virtualized rows, today marker | 2 |
| **2** | Dependency arrows, drawn from `issue_dependencies`; hover highlight of a chain | 1 |
| **3** | Drag to move, drag edges to resize, snapping, optimistic + conflict handling | 1.5 |
| **4** | Critical path, over-allocation shading, baseline vs actual | 1 |
| **5** | Export to PNG/PDF via the reports worker | 0.5 |

**Stage 1 alone satisfies the requirement to see a plan over time.** Stages 3–5
are deferrable without the feature being absent, which is exactly the property
the commercial fallback was buying.

## Alternatives

**Commercial components.** Rejected — no budget. Worth restating that they were
the better engineering choice; this is a cost decision, not a technical one.

**Open-source Gantt libraries** (`frappe-gantt`, `dhtmlx-gantt` GPL build,
`gantt-task-react`). Rejected after weighing seriously:

- None virtualize rows, so 500+ rows is not viable against NFR targets
- Styling is hard to reconcile with the ported CSS-variable theme, and dark mode
  usually needs forking
- Several are unmaintained or have a GPL/commercial dual licence whose free side
  does not permit our use
- A fork is not cheaper than a build once virtualization has to be added

They remain worth a half-day spike at the start of Stage 1 to confirm this
judgement against their current state, rather than assuming it.

**Reuse the Timeline component for Gantt.** Partially adopted — Timeline is the
same rendering core with dependencies and drag disabled, so it is built once.

**Drop Gantt.** Rejected: it is a named requirement (FR-27) and a common
evaluation checkbox in this category.

## Consequences

- **Phase 2 grows by ~3 EW** (from a 3-week timebox to a 5–6 EW build)
- We own the hardest rendering component in the product. It needs its own test
  set: virtualization correctness, arrow routing, drag snapping, timezone
  boundaries at DST transitions
- Positive side-effect: the virtualized-timescale core is reused by Timeline,
  Roadmap and the capacity view — three requirements served by one component,
  which is not true of a licensed drop-in
- No licence audit, no vendor dependency, no per-developer seat cost, and full
  control of accessibility (keyboard drag is a WCAG 2.1 AA requirement that
  several commercial Gantts fail)
- Risk concentrates in one person's head unless deliberately shared. Pair or
  review Stage 1 and 3 closely

## Reversal

If budget appears mid-build, stop at whatever stage is complete and evaluate a
purchase — the component is behind a stable prop interface, so swapping it is a
contained change.

Reverse if Stage 1 exceeds 3 EW, which would indicate the estimate was wrong at
its most predictable point and the later stages will be worse.
