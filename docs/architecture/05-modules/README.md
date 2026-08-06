# Module specifications

One file per module. Each follows the same template so they can be read, and
implemented, in the same shape.

| # | Module | Phase | File |
|---|---|---|---|
| 1 | Authentication and identity | 0 | [01-authentication.md](01-authentication.md) |
| 2 | Workspace, teams and directory | 0 | [02-workspace.md](02-workspace.md) |
| 3 | Projects and issues | 1 | [03-projects-issues.md](03-projects-issues.md) |
| 4 | Planning: sprints, releases, roadmap | 2 | [04-planning.md](04-planning.md) |
| 5 | Time tracking and reporting | 3 | [05-time-reporting.md](05-time-reporting.md) |
| 6 | Collaboration: docs, chat, meetings | 4 | [06-collaboration.md](06-collaboration.md) |
| 7 | Automation and integration | 5 | [07-automation.md](07-automation.md) |
| 8 | Notifications | 1 | [08-notifications.md](08-notifications.md) |
| 9 | Administration | 6 | [09-admin.md](09-admin.md) |

## Template

Every module document carries these sections, in this order:

1. **Objectives** — what problem this module solves, in one paragraph
2. **Functional requirements** — traceable to the FR numbers in
   [../01-requirements.md](../01-requirements.md)
3. **Non-functional requirements** — the targets specific to this module
4. **UI screens** — every screen, with its purpose and primary action
5. **User flow** — the main path, as a sequence
6. **Database design** — tables, columns that matter, relationships
7. **APIs** — endpoints, with method, path and purpose
8. **Components** — which design-system primitives, which new ones
9. **Best practices** — the module-specific conventions to hold to
10. **Security considerations** — what an attacker would try here
11. **Scalability considerations** — what breaks first as this module grows
12. **Risks** — with mitigations
13. **Implementation order and estimate** — engineer-weeks

## Conventions across all modules

- Every table carries `workspace_id` unless it appears in `GLOBAL_TABLES`
- Every repository function takes `ctx: RequestContext` first
- Every mutation writes an `outbox_events` row in the same transaction
- Every editable entity has `version`, and its `PATCH` requires `If-Match`
- Every list endpoint is cursor-paginated
- Every module's endpoints live under `/api/v1/w/:workspaceSlug/`, except the
  four explicitly-enumerated cross-workspace routes in
  [../03-tenancy.md](../03-tenancy.md)
