# Module 2 — Workspace, teams and directory

**Phase 0** · ~5 EW

## 1. Objectives

Establish the scope boundary everything else lives inside, and the people
structures that hang off it. This module defines `workspace_id` — the column that
[../03-tenancy.md](../03-tenancy.md) spends its length defending.

## 2. Functional requirements

FR-10 (workspaces, switching), FR-11 (teams), FR-12 (departments, designations,
skills, availability), FR-13 (branding).

## 3. Non-functional

| | |
|---|---|
| Workspace switch | < 300ms to first paint of the new workspace |
| Member list | 5,000 members, virtualized, < 1s |
| Scope resolution | Two indexed queries, cached 30s |

## 4. UI screens

| Screen | Purpose | Primary action |
|---|---|---|
| Workspace switcher | Dropdown in the shell header; keyboard-navigable | Switch |
| Workspace home | Activity, my work, pinned projects | — |
| Members | Table: name, role, teams, last active. Filter, bulk role change | Invite |
| Member detail | Profile, projects, workload, skills | Edit role |
| Teams | Grid of teams with member avatars and lead | Create team |
| Team detail | Members, projects, workload, capacity | Add member |
| Directory settings | Departments, designations, skills as editable lists | Add |
| Availability | Working hours, capacity per week, PTO calendar | Set |
| Workspace settings | Name, slug, logo, accent colour, defaults | Save |

## 5. User flow — create a workspace and staff it

```
Admin → Create workspace (name, slug)
      → workspace + workspace_members(admin) + default labels
        + default board columns template, in ONE transaction
      → Invite members with roles
      → Create teams, assign members and a lead
      → Set departments and designations
      → Members set their own availability
```

Seeding defaults in the same transaction matters: a workspace that exists but has
no board columns is a broken workspace, and a half-created one is worse than a
failed creation.

## 6. Database

| Table | Notes |
|---|---|
| `organizations` | Exactly one row today. Exists so orgs can be added later without touching 200 tables |
| `workspaces` | `organization_id`, `slug` unique, `name`, `logo_file_id`, `accent_color`, `settings jsonb` |
| `workspace_members` | `(workspace_id, user_id)` PK, `role`, `joined_at`. **This is the scope resolution table** |
| `teams` | `workspace_id`, `name`, `lead_user_id`, `description` |
| `team_members` | `(team_id, user_id)` PK, `role_in_team` |
| `departments` | `workspace_id`, `name`, `parent_id` (nullable, for hierarchy) |
| `designations` | `workspace_id`, `name`, `level` |
| `skills` | `workspace_id`, `name`, `category` |
| `user_skills` | `(user_id, skill_id)`, `proficiency` |
| `user_availability` | `workspace_id`, `user_id`, `hours_per_week`, `working_days`, `timezone` |
| `user_time_off` | `workspace_id`, `user_id`, `start_date`, `end_date`, `type` |

`organizations` and `workspaces` are in `GLOBAL_TABLES`; everything else here
carries `workspace_id`.

## 7. APIs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/me/workspaces` | My workspaces — cross-workspace, self-scoped |
| POST | `/api/v1/workspaces` | Create (org admin) |
| GET/PATCH | `/api/v1/w/:ws` | Read / update settings |
| GET | `/api/v1/w/:ws/members` | Cursor-paginated, filterable |
| PATCH | `/api/v1/w/:ws/members/:userId` | Change role (`manage_members`) |
| DELETE | `/api/v1/w/:ws/members/:userId` | Remove |
| GET/POST | `/api/v1/w/:ws/teams` | |
| GET/PATCH/DELETE | `/api/v1/w/:ws/teams/:id` | |
| POST/DELETE | `/api/v1/w/:ws/teams/:id/members` | |
| GET/POST/PATCH/DELETE | `/api/v1/w/:ws/{departments,designations,skills}` | |
| GET/PUT | `/api/v1/w/:ws/members/:userId/availability` | |
| GET | `/api/v1/w/:ws/workload` | Assigned points/hours vs capacity |

## 8. Components

`Table`, `Badge`, `Card`, `Modal`, `ConfirmDialog`, `Field` — ported.
New: `Avatar`, `AvatarGroup`, `Combobox` (member picker), `Tabs`, `Stat`,
`DatePicker` (time off).

## 9. Best practices

- **Workspace creation is one transaction.** Workspace + admin membership +
  default labels + default board columns, or nothing.
- **Removing a member cascades correctly:** `workspace_members` and
  `project_members` go; authored content (`issues.created_by`, comments) sets
  null and keeps a denormalized display name — porting the `author_email`
  denormalization already used by `task_comments`, which is what stops a
  comment thread turning into a row of "Unknown".
- **A member removal emits an outbox event** that closes their open sockets and
  invalidates cached principals. Without it they keep receiving updates.
- **Slugs are immutable after creation.** Changing one breaks every shared URL;
  offer a redirect table if it is ever genuinely needed.

## 10. Security

| Threat | Control |
|---|---|
| Enumerating workspaces by slug | Non-member gets **404**, never 403 |
| Privilege escalation via role change | An actor cannot grant a role above their own; the last admin cannot be demoted or removed |
| A removed member retaining access | Principal cache TTL 30s; outbox event closes sockets immediately |
| Cross-workspace member listing | `workspace_id` scope on every query; covered by the poison-row suite |

## 11. Scalability

Member lists are cursor-paginated and virtualized. The workload query aggregates
per assignee over open issues — indexed on `(workspace_id, assignee_id, status)`
and materialized nightly if it exceeds 500ms.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Team hierarchy invites unbounded nesting | Departments allow one level of parent; teams are flat. Revisit only with evidence |
| Availability data goes stale and misleads planning | Show `last_updated`; prompt quarterly; never present stale capacity as current |
| The last admin removes themselves | Enforced in the service layer, with a clear error |
| `GLOBAL_TABLES` grows | Quarterly review; PR template requires justification |

## 13. Implementation order

1. `workspaces`, `workspace_members`, scope resolution into `RequestContext`
2. Workspace CRUD, switcher, settings
3. Member list, role management, removal with cascade and socket close
4. Teams
5. Directory: departments, designations, skills
6. Availability and the workload view
