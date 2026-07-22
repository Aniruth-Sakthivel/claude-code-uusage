# ClaudeFleet

> Centralized Claude Code usage monitoring across multiple PCs.
> **Original software** — not derived from or dependent on any third-party project.
> (*"ClaudeFleet" is a working name; rename freely.*)

ClaudeFleet answers one question across a fleet of machines:

> **Which PC is generating the most tracked Claude Code token activity?**

It reads Claude Code's local JSONL transcript files on each PC, stores a
centralization-ready usage record in local SQLite, and (in central mode) syncs
that metadata to a central API + dashboard.

> **Tracked activity ≠ official quota.** All numbers are token counts parsed from
> local transcript files — an observability *estimate*, not a reading of
> Anthropic's official Claude Max/Pro quota or billing.

## Repository layout

```
agent/     local agent — scanner, local SQLite store, sync client, CLI
server/    central API (FastAPI + SQLAlchemy) — auth, RBAC, sync, dashboard endpoints
web/       central dashboard (React + Vite + TypeScript + Tailwind)
docs/      audit (format spec), centralization plan, run guide
```

## Run the project

Three parts: the **server** (central API), the **web** dashboard, and the
**agent** on each PC. For a single machine you only need the agent; for the
central dashboard, run all three. Prerequisites: **Python 3.10+** and **Node 18+**.

### 1 — Start the central server (run once)

```bash
cd server
python -m venv .venv && .venv\Scripts\activate    # Windows (use source .venv/bin/activate on macOS/Linux)
pip install -e .
python run.py                                      # serves http://127.0.0.1:8000
```

First run auto-creates the SQLite database and seeds roles. Set a real secret in
production: `set CLAUDEFLEET_JWT_SECRET=<random-32+ chars>` (PowerShell:
`$env:CLAUDEFLEET_JWT_SECRET="..."`). API docs live at `http://127.0.0.1:8000/docs`.

### 2 — Start the web dashboard

```bash
cd web
npm install
npm run dev                                        # opens http://localhost:5173
```

Open **http://localhost:5173**:
1. **Create the admin account** on `/register` (available only until the first user exists).
2. Sign in → name your first machine on the **Set up this machine** panel → copy its **API key** (shown once).
3. Add more people under **Admin → Users & roles** (role + assigned systems). They sign in at `/login`; RBAC scopes what they see (developers → only their assigned systems).

### 3 — Run the agent on each PC

```bash
cd agent
python -m claudefleet register --server http://SERVER:8000 --api-key cfk_... --display-name PC-01
python -m claudefleet scan        # ingest local transcripts
python -m claudefleet sync        # push new usage to the server
python -m claudefleet heartbeat   # liveness ping
```

Schedule `scan` + `sync` (e.g. every 15 min) and `heartbeat` (every 5 min) with
Windows Task Scheduler — see [agent/README.md](agent/README.md).

> Full walkthrough with troubleshooting: [docs/RUNNING.md](docs/RUNNING.md).

## Agent — local mode (works today, no server required)

> 📘 **Full install & scan walkthrough:** [agent/README.md](agent/README.md)


```bash
cd agent
python -m claudefleet identity --display-name PC-01   # one-time machine label
python -m claudefleet scan                            # ingest transcripts
python -m claudefleet today                           # today's usage
python -m claudefleet week                            # last 7 days
python -m claudefleet stats                           # all-time
```

- Pure Python standard library in local mode (no dependencies).
- Local store defaults to `~/.claude/claudefleet/usage.db` (override with `CLAUDEFLEET_DB`).
- Machine identity in `~/.claude/claudefleet/agent.json` (override with `CLAUDEFLEET_CONFIG`).
- **Idempotent & incremental:** re-running `scan` never double-counts (event ids are machine-namespaced and `INSERT OR IGNORE`d).

## Design highlights

- **`event_id = system_id : message_id`** (deterministic synthetic id when a
  record has no message id) — globally unique across the fleet, so a usage event
  can never be counted twice, even across re-scans or re-syncs.
- **`usage_events` is the single source of truth**; day/model/session rollups are
  SQL aggregations (no dual-write drift).
- **UTC timestamps** stored internally; local time only for display.
- **Privacy:** only metadata + token counts are ever stored/synced — never
  prompts, responses, or source code.

## Tests

```bash
cd agent  && python -m pytest    # 33 tests — parser, store, scanner, pricing, identity
cd server && python -m pytest    # 14 tests — auth, register, sync/dedup, dashboard, RBAC scoping
cd web    && npm run build        # type-check + production build
```

See [docs/CENTRALIZATION_PLAN.md](docs/CENTRALIZATION_PLAN.md) for the roadmap and
[docs/UPSTREAM_AUDIT.md](docs/UPSTREAM_AUDIT.md) for the JSONL format reference.
