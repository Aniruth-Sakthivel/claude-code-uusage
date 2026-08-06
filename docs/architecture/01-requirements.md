# Requirement analysis

## 1. Objectives

Give an organization one place to plan, execute, discuss and measure work,
without the per-seat cost and configuration weight of Jira, and without
ClickUp's tendency to become unnavigable at scale.

Three things must be true or the product has no reason to exist:

1. **It is fast.** A board opens in under a second with 2,000 cards. A drag
   commits in one round trip. Search returns in under 200ms. This is the single
   most common reason teams leave Jira.
2. **It is live.** Two people on the same board see each other's changes without
   refreshing. Anything less feels broken in 2026.
3. **It is honest.** Every number on screen can be traced to something real, and
   anything stale says so.

## 2. Actors

| Actor | Scope | Notes |
|---|---|---|
| Org admin | Everything | Billing, workspace creation, SSO config, audit |
| Workspace admin | One workspace | Members, projects, custom fields, automation |
| Project manager | Assigned projects | Sprints, releases, roadmap, reports |
| Team lead | Assigned team + projects | Capacity, assignment, approvals |
| Contributor (dev/QA/design) | Assigned projects | Issues, comments, time entries |
| Viewer | Assigned projects, read-only | Stakeholders |
| Client | Explicitly shared projects only | External. Read + comment. **Never** sees workspace-wide surfaces |
| Service account | Scoped by PAT | API and integrations |

The `client` actor is the sharp edge. Meterhouse learned this the hard way and
solved it with a dedicated `requireStaff` guard that excludes clients from every
workspace-wide surface (wiki, reports, search, calendar, automations,
whiteboard, chat). Port that decision — a client who can call
`GET /workspace/search` sees every project in the company.

## 3. Functional requirements

Numbered for traceability; each maps to a module doc in [05-modules/](05-modules/).

### Identity and access
- **FR-1** Email/password, magic link, OAuth and SAML SSO sign-in
- **FR-2** MFA (TOTP), optionally enforced per workspace
- **FR-3** List active sessions and devices; revoke individually or all
- **FR-4** Invite by email with a role; invitation expires; resend and revoke
- **FR-5** Custom roles composed from a fixed capability set
- **FR-6** Personal access tokens, scoped, revocable, with last-used tracking

### Workspace and directory
- **FR-10** Multiple workspaces; a user may belong to several; fast switching
- **FR-11** Teams with members, leads and a workload view
- **FR-12** Departments, designations, skills, availability and capacity
- **FR-13** Workspace branding (name, logo, accent colour)

### Projects and work
- **FR-20** Projects with key prefix, lead, members, dates and health
- **FR-21** Issues of type task/bug/story/epic/subtask/spike, with a
  human-readable key (`ENG-142`)
- **FR-22** Per-project workflow: custom columns, WIP limits, transition rules
- **FR-23** Subtasks, dependencies (`blocks`/`blocked by`), and related links
- **FR-24** Labels, priority, story points, estimates, due dates, watchers
- **FR-25** Custom fields per workspace and project, with typed validation
- **FR-26** Issue templates and recurring issues
- **FR-27** Board, list, calendar, timeline, Gantt and roadmap views
- **FR-28** Saved views, shareable by URL
- **FR-29** Bulk edit by selection or by filter
- **FR-30** Attachments on issues, comments and docs

### Planning
- **FR-40** Backlog with drag-ordering and sprint assignment
- **FR-41** Sprints with planning, active and completed states; one active per project
- **FR-42** Milestones and releases
- **FR-43** Burndown, burnup, velocity, cumulative flow, cycle time
- **FR-44** Capacity planning against declared availability

### Collaboration
- **FR-50** Comments with @mentions, reactions and threading
- **FR-51** Docs/wiki with version history, diff and restore
- **FR-52** Chat: channels, DMs, threads, reactions, read state, file sharing
- **FR-53** Whiteboards
- **FR-54** Meetings with agenda, attendees and calendar sync

### Time and reporting
- **FR-60** Start/stop timer and manual entry, billable flag
- **FR-61** Timesheets with submission and approval
- **FR-62** Dashboards composed from widgets; executive, team and personal
- **FR-63** Async export to CSV/XLSX/PDF; scheduled report delivery

### Automation and integration
- **FR-70** Rules: trigger → conditions (a filter expression) → actions
- **FR-71** Scheduled and approval workflows
- **FR-72** Outbound webhooks with signing, retry and delivery log
- **FR-73** Public REST API with OpenAPI documentation
- **FR-74** Import from Jira, Trello, Asana and CSV

### Notifications
- **FR-80** In-app, email and push; per-type preferences
- **FR-81** Digest emails (daily/weekly), respecting quiet hours

### Administration
- **FR-90** Audit log with export and retention policy
- **FR-91** Feature flags
- **FR-92** Storage usage and quota per workspace
- **FR-93** System health, queue depth and failed-job replay

## 4. Non-functional requirements

| ID | Requirement | Target | Verified by |
|---|---|---|---|
| **NFR-1** | Board load, 2,000 cards | p95 < 1.0s | Playwright + seeded fixture |
| **NFR-2** | Issue list, 10,000 rows | 60fps scroll | Manual + React Profiler |
| **NFR-3** | API read latency | p95 < 200ms | OTel histogram |
| **NFR-4** | API write latency | p95 < 400ms | OTel histogram |
| **NFR-5** | Search latency | p95 < 200ms | OTel + trip-wire alert at 400ms |
| **NFR-6** | Realtime delivery | p95 < 500ms end to end | Synthetic probe |
| **NFR-7** | Initial JS bundle | < 180KB gzipped | CI budget, hard fail |
| **NFR-8** | Availability | 99.9% | Uptime monitor |
| **NFR-9** | RPO / RTO | 5 min / 1 hour | Quarterly restore drill |
| **NFR-10** | Accessibility | WCAG 2.1 AA | axe in CI + annual audit |
| **NFR-11** | Cross-tenant leakage | Zero | Poison-row suite, blocking CI gate |
| **NFR-12** | Job durability | No silent loss | DLQ + replay UI + depth alert |

NFR-11 is the one that ends the company if it fails. It is enforced structurally
rather than by review — see [03-tenancy.md](03-tenancy.md).

## 5. Explicitly out of scope for v1

Written down so they cannot be smuggled in mid-phase:

- Multiple organizations and cross-org sharing (the schema permits adding it; the
  product does not expose it)
- Per-seat billing and payment processing
- Native mobile apps — responsive web only
- Offline mode
- Real-time collaborative rich-text editing (CRDT/OT). Docs use
  last-write-wins with version conflict detection
- Video/voice calling
- Marketplace and third-party plugins
- On-premise or self-hosted distribution
- Multi-language UI (the *data* is language-agnostic; the chrome is English)

## 6. Assumptions

1. A single organization. Multi-org is a schema-compatible future change, not a
   v1 feature.
2. One primary region. Data residency is not a requirement yet.
3. Supabase Auth remains the identity provider — it supplies MFA, magic link,
   OAuth and SAML, which is four requirements met by configuration rather than
   code. Verify SAML/SCIM pricing before committing to FR-1 at the enterprise
   tier.
4. English-only interface at launch.
5. Teams are under 500 people per workspace, which keeps presence and mention
   fan-out uncomplicated.

## 7. Risks to the requirements themselves

| Risk | Why it matters | Response |
|---|---|---|
| "Jira parity" is not a specification | The gap list has 30 items and no bottom | Every phase ships a written, versioned cut list with explicit *not in v1* entries |
| Custom fields make every performance target conditional | Unbounded JSONB sort/filter table-scans | Cap filterable fields; index them separately; return 400 rather than a slow 200 |
| Realtime plus optimistic UI is the hardest correctness problem here | "My change disappeared" is unreproducible in a bug report | Version-based reconciliation, deterministic out-of-order tests |
| Gantt is a product requirement with an engineering cliff behind it | Genuinely 4–8 weeks; every estimate underestimates it | Timebox to 3 weeks, price commercial components before Phase 2 |
