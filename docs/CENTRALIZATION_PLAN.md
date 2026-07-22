# Centralization Plan — 3-PC Claude Code Usage Monitoring Platform

> Technical proposal to extend the audited single-PC tool (see [`UPSTREAM_AUDIT.md`](UPSTREAM_AUDIT.md), v1.5.5) into a centralized platform answering: **"Which of PC-01 / PC-02 / PC-03 is generating the most tracked Claude Code token activity?"** — while keeping the existing standalone tool fully working.
>
> **Status:** ClaudeFleet is **original software** (no third-party project reused). Phase 0 (our own local agent + scanner) is **implemented and verified**. Everything from Phase 1 (central API) onward is the roadmap below.

---

## Guiding principles

1. **Our own code.** The agent (`agent/claudefleet/`) is written from scratch against Claude Code's on-disk JSONL format; it uses only standard frameworks (stdlib locally; FastAPI/React centrally), never a forked project.
2. **Two modes coexist.** LOCAL mode (agent CLI) works with zero central dependency; CENTRALIZED mode layers on top.
3. **Additive, versioned schema.** Schema changes go through `Store.init_schema` (idempotent) + migrations keyed on `meta.schema_version`.
4. **No conversation content ever leaves the machine** — only metadata + token counts. Never prompts, responses, or source code.
5. **Server-side authorization is the source of truth.** React never decides who sees what.
6. **No double counting.** Deterministic global `event_id` + DB `UNIQUE` constraint.
7. **Offline-first.** The agent queues and retries; the scanner never depends on the server being up.
8. **Tracked tokens ≠ Max/Pro quota** — surfaced explicitly in every relevant view.

---

## Two-mode architecture

**LOCAL (implemented):**
```
Claude Code → agent scanner → ~/.claude/claudefleet/usage.db → CLI (scan/today/week/stats)
```

**CENTRALIZED (roadmap):**
```
Claude Code → agent scanner → local SQLite → Sync client → Central API → Central DB → React Dashboard
                                              (offline queue,  (FastAPI)   (SQLite)   (Vite/TS)
                                               retry, heartbeat)
```

Repository layout (monorepo root):
```
/agent/         ✅ our local agent: claudefleet/{identity,parser,store,scanner,pricing,reports,cli}.py + tests
/server/        ⏳ FastAPI central API (Router→Service→Repository), Alembic migrations
/web/           ⏳ React + TS + Vite + Tailwind + TanStack Query + ApexCharts + Lucide
/deploy/        ⏳ install.ps1 / uninstall.ps1 / update.ps1 (Windows Task Scheduler)
/docs/          format reference + this plan
```

---

## The dedup key (core design decision)

From the audit: `turns.message_id` is already `UNIQUE` per local DB. The global identity is:

```
event_id = f(system_id, message_id)              # message_id present (the ~99% case)
event_id = f(system_id, sha1(session_id|timestamp|tool_name|input|output|cache_read|cache_creation))
                                                  # deterministic synthetic id for message_id-less turns
```

The server enforces `usage_events.event_id UNIQUE`. Re-sending an event → duplicate ignored, never re-counted. `POST /usage/sync` returns `{received, inserted, duplicates, failed}`.

---

## Multi-PC identity

Persisted in a local agent config file (e.g. `~/.claude/agent.json`), **not** derived from hostname alone:

```
system_id       UUID (generated once, immutable)
installation_id UUID (per install; rotates on reinstall)
hostname        os.uname/socket hostname (informational)
display_name    "PC-01" / "PC-02" / "PC-03"
agent_version   sync agent semver
status          online / offline (server-derived from last_seen_at)
last_seen_at    UTC
created_at      UTC
```

---

## Phased roadmap (execute after approval)

| Phase | Deliverable | Key notes |
|---|---|---|
| **0 ✅** | Vendor upstream + `UPSTREAM_AUDIT.md` + `CENTRALIZATION_PLAN.md` | Done. 147 tests green; scanner verified on this PC. |
| **1** | **Sync agent** (`/agent`) | Read local DB read-only; `sync_state` table (watermark = last synced `turns.id`); build `event_id`; batch POST; exponential-backoff retry; offline queue; heartbeat. New sync tests. |
| **2** | **Central API** (`/server`) | FastAPI + SQLAlchemy + Alembic + SQLite. Router→Service→Repository. Endpoints below. |
| **3** | **Central data model** | `systems, projects, sessions, usage_events, daily_aggregates, sync_logs`. UTC internally. `daily_aggregates` rollup for fast dashboards. |
| **4** | **Central React dashboard** (`/web-dashboard`) | Ranking-first ("which PC uses most"), summary tiles, systems comparison, project/session analytics (metadata only). |
| **5** | **User auth** | `users, roles, permissions, user_roles, user_systems`. Hashed passwords (argon2/bcrypt). Login/logout/session (JWT or server session). |
| **6** | **RBAC + server-side data authorization** | Administrator / Manager / Developer / Viewer. Developer scoped to assigned `user_systems` — enforced in the repository layer, tamper-proof. |
| **7** | **Agent API keys** | Per-PC bearer keys, create/rotate/revoke, hash-at-rest, shown once. Fully separate from user auth. |
| **8** | **Audit logs** | `audit_logs` for auth/user/role/system/key/settings events. Never logs secrets/prompts/responses/code. |
| **9** | **Windows deployment** | `install.ps1 / uninstall.ps1 / update.ps1`; Task Scheduler: scan+sync every 15 min, heartbeat every 5 min. |

**Migration order (never skip):** preserve scanner → preserve local DB → add sync layer → add central API → add central DB → add React dashboard → add auth → add RBAC → add Windows deploy. Write tests before each refactor.

---

## Central API surface (Phase 2)

```
POST /api/v1/systems/register      # agent → returns/confirms system_id (agent key auth)
POST /api/v1/systems/heartbeat     # agent → updates last_seen_at (agent key auth)
GET  /api/v1/systems               # user → scoped by role/assignment

POST /api/v1/usage/sync            # agent → batch upsert; returns received/inserted/duplicates/failed

GET  /api/v1/dashboard/summary     # today/week/month/total, active systems, highest consumer
GET  /api/v1/dashboard/timeseries  # usage over time (per system/project/model)
GET  /api/v1/dashboard/ranking     # PC ranking by tracked tokens (the headline)

GET  /api/v1/projects              # scoped
GET  /api/v1/sessions              # scoped; metadata only
```

Business logic lives in the **service** layer; route handlers stay thin. Data scoping lives in the **repository** layer so every query is filtered by the caller's authorized systems.

---

## Central data model (Phase 3)

- **`systems`** — the identity fields above.
- **`projects`** — `(system_id, project_name)` unique; disambiguates cross-PC name collisions noted in the audit.
- **`sessions`** — `(system_id, session_id)` unique; mirrors local session aggregates + `system_id`.
- **`usage_events`** — one row per synced turn; `event_id UNIQUE`; FKs to system/project/session; input/output/cache_read/cache_creation, model, timestamp (UTC), is_subagent.
- **`daily_aggregates`** — `(system_id, day, model)` rollup for dashboard speed.
- **`sync_logs`** — per-sync batch record (system, counts, timestamp) for observability.

All timestamps stored UTC; converted to local only for display.

---

## Security model

- **Two independent auth systems:** user JWT/session (humans) vs per-PC API keys (agents). Neither accepts the other's credentials.
- **Server-side authorization is mandatory** — a Developer assigned to PC-01 gets only PC-01 even if they hand-craft `GET /systems`; the repository layer filters by `user_systems`. RBAC tests assert this directly against the API.
- **Privacy invariants:** transcripts read-only; only metadata + token counts transmitted; audit logs and sync payloads never contain prompts, responses, source, passwords, or keys.

---

## Testing plan (per phase)

- **Scanner:** keep the 147 upstream tests green (regression gate).
- **Sync:** successful sync, offline server, retry/backoff, duplicate events (no double count), partial sync, recovery after reconnect, synthetic `event_id` stability.
- **RBAC:** each role's allowed/denied matrix; **Developer cannot reach unassigned systems** even with tampered requests — tested against the live API.
- **Dashboard:** loading / empty / error / offline-system states; date/system/project filters.

---

## Explicit non-goals / rules honored

No scanner rewrite · reuse proven logic · preserve local standalone · no upload of conversation content · never modify Claude Code's files · no network interception · no browser scraping · no frontend-only authorization · never double-count · offline support · incremental scanning · migrations for schema changes · modular architecture · document all upstream modifications · tracked tokens clearly distinguished from official Max quota.
