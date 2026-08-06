# Module 5 — Time tracking and reporting

**Phase 3** · ~20–26 EW

## 1. Objectives

Record where time actually went, and turn the whole dataset into answers
executives, leads and individuals each need — without three separate reporting
engines.

## 2. Functional requirements

FR-60 (timer and manual entry, billable), FR-61 (timesheets and approval),
FR-62 (dashboards: executive, team, personal), FR-63 (async export, scheduled
reports).

## 3. Non-functional

| | Target |
|---|---|
| Timer start/stop | < 100ms, optimistic |
| Dashboard load | < 1.5s for 12 months of data |
| Export, 100k rows | Async job, emailed link, < 2 min |
| Report accuracy | Must reconcile exactly with the underlying entries |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Timer widget | Persistent in the shell; current task, elapsed | Start / stop |
| Time entry | Manual entry: issue, date, duration, billable, note | Save |
| My timesheet | Week grid, day × issue, totals | Submit |
| Team timesheets | Approval queue with variance flags | Approve |
| Executive dashboard | Portfolio health, spend, delivery trend | — |
| Team dashboard | Velocity, workload, cycle time, WIP | — |
| Personal dashboard | My work, my time, my week | — |
| Report builder | Pick dimensions, measures, filters; save | Save report |
| Scheduled reports | Recipients, cadence, format | Schedule |

## 5. User flow

```
Start timer on an issue  → one running entry per user, enforced
Switch task              → previous entry stopped and closed automatically
End of week              → review grid, correct, submit timesheet
Lead                     → approval queue, variance vs capacity flagged
Approved                 → locked; edits require a reopen with an audit entry
```

## 6. Database

| Table | Notes |
|---|---|
| `time_entries` | `workspace_id`, `user_id`, `issue_id`, `started_at`, `ended_at`, `duration_minutes`, `is_billable`, `note`, `source` (timer\|manual\|import) |
| `timesheets` | `(workspace_id, user_id, week_start)`, `status`, `submitted_at`, `total_minutes` |
| `timesheet_approvals` | `approver_id`, `decision`, `comment`, `at` |
| `saved_reports` | Definition as a filter AST + dimensions + measures |
| `report_schedules` | Cadence, recipients, format, `last_run_at` |

Partial-unique enforcing one running timer per user — the same pattern as the
active sprint:

```sql
CREATE UNIQUE INDEX ON time_entries (user_id) WHERE ended_at IS NULL;
```

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| POST | `/w/:ws/time/start` · `/stop` | Timer |
| GET/POST/PATCH/DELETE | `/w/:ws/time-entries` | Manual entry |
| GET | `/w/:ws/timesheets/me?week=` | |
| POST | `/w/:ws/timesheets/:id/submit` · `/approve` · `/reject` | |
| GET | `/w/:ws/reports/{executive,team,personal}` | |
| GET/POST | `/w/:ws/saved-reports` | |
| POST | `/w/:ws/exports` | Returns `202` + job id |
| GET | `/w/:ws/exports/:id` | Status, then a signed download URL |
| GET/POST | `/w/:ws/report-schedules` | |

## 8. Components

Ported: `TimeseriesChart`, `RankingBars`, `Table`, `Card`. New: `Stat`,
`DateRangePicker`, `DataGrid`, `Tabs`, plus a small set of dashboard widgets.

## 9. Best practices

- **One running timer per user**, enforced by the database. Starting a second
  stops the first, and says so.
- **Exports are always async.** This is one of the workloads the 26s serverless
  cap killed, and the reason for the `reports` queue.
- **Approved timesheets are immutable** without an explicit reopen that writes
  an audit entry. Otherwise "approved" means nothing.
- **Reports reuse the filter AST.** No second query language.
- **Durations in integer minutes**, never floating-point hours — 7.4 hours has
  no exact representation and the totals will not reconcile.

## 10. Security

| Threat | Control |
|---|---|
| Seeing another person's time entries | Own entries only, unless `view_all_projects` or team lead over that user |
| Billable data leaking to a client-role user | Time is never exposed on client-portal surfaces |
| Export as a bulk exfiltration channel | `export` capability, rate-limited 5/hour, every export audited |
| Approving your own timesheet | Approver must differ from the owner; enforced in the service |

## 11. Scalability

Dashboards read pre-aggregated daily rollups, not raw entries — the same
`daily_aggregates` pattern the current codebase uses for usage, which is a proven
shape. Exports stream in chunks to R2 rather than buffering in memory.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Time tracking is resented and produces bad data | Optional per workspace; timer is one click from any issue; never used punitively in the default dashboards |
| Reports disagree with the raw entries | One aggregation path, with a reconciliation test asserting rollups equal the sum of entries |
| Report builder becomes a BI tool | Fixed dimension and measure lists in v1. No arbitrary SQL, no custom joins |
| Timezone errors in weekly totals | Week boundaries computed in the user's timezone from `user_profiles`; the UTC-bucket lesson from `api/src/core/time.ts` applies directly |

## 13. Implementation order

1. `time_entries`, timer start/stop, manual entry
2. Timer widget in the shell
3. Weekly timesheet grid
4. Submission and approval
5. Daily rollups
6. Personal → team → executive dashboards
7. Report builder over the filter AST
8. Async export jobs
9. Scheduled report delivery
