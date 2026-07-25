# ClaudeFleet

> Centralized Claude Code usage monitoring across multiple PCs.

ClaudeFleet answers one question across a fleet of machines:

> **Which PC is generating the most Claude Code token activity?**

It reads the JSONL transcript files Claude Code already writes on each PC, stores
usage locally in SQLite, and syncs the metadata to a central API + dashboard.

> **Tracked activity ≠ official quota.** All numbers are token counts parsed from
> local transcript files — an observability *estimate*, not a reading of
> Anthropic's official Claude Max/Pro quota or billing.

**Privacy:** only token counts and metadata ever leave a machine. Never prompts,
responses, or source code. The agent never modifies Claude Code's files.

---

## Layout

```
agent/    local agent (Python, standard library only) — scanner, store, sync, CLI
api/      central API (Node + Fastify + Drizzle on Supabase Postgres)
web/      dashboard (React + Vite + TypeScript + Tailwind v4)
netlify/  serverless function entry — the API runs here in production
docs/     format reference, deployment, run guide
```

The API and dashboard deploy together to **Netlify as a single site**: the
dashboard is static, the API is a serverless function on the same origin. No
separate backend host, and no CORS to configure.

---

## Quick start

Prerequisites: **Node 20+**, **Python 3.10+**, and a **Supabase** project.

### 1. Configure

```bash
cp api/.env.example api/.env
cp web/.env.example web/.env
```

Fill in from your Supabase dashboard:

| Variable | Where to find it |
|---|---|
| `DATABASE_URL` | **Connect → Transaction pooler** (port **6543**) |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | **Settings → API** |
| `DIRECT_URL` | **Connect → Session pooler** (port **5432**) — migrations only |

> Use the **pooler**, not `db.<ref>.supabase.co`. Newer Supabase projects publish
> no DNS for direct connections, and serverless functions exhaust them anyway.

### 2. Install and migrate

```bash
npm install          # installs api/ and web/ (npm workspaces)
npm run db:migrate   # creates the schema and seeds roles
```

### 3. Run

```bash
npm run dev          # API on :8000, dashboard on :5173
```

Open **http://localhost:5173**:

1. **Create the admin account** — the first user to sign up becomes administrator.
   Registration closes automatically afterwards.
2. **Connect this PC** — copy the single generated command, run it in PowerShell.
   It installs the agent, registers the machine, scans, syncs, and schedules
   scan + sync every 15 minutes.
3. Usage appears on the dashboard after the first sync.

### 4. Add teammates

**Admin → Users & roles** → invite by email. They set their own password from the
invite link.

| Role | Sees | Can manage |
|---|---|---|
| Administrator | all PCs | users, keys, systems, audit |
| Manager | all PCs | — |
| Developer | **only assigned PCs** | — |
| Viewer | all PCs | — |

Scoping is enforced in the data layer, so a developer cannot reach an unassigned
machine even by hand-crafting a request.

---

## Connecting a PC

The dashboard generates a one-line command:

```powershell
irm https://your-site.netlify.app/api/v1/connect/script/<token> | iex
```

The token is **single-use and expires in 15 minutes**, so the command is safe in
shell history — the real API key is substituted server-side.

Prefer to do it manually? The Connect page also shows the individual commands:

```powershell
pip install claudefleet-agent
claudefleet register --server https://your-site --api-key cfk_... --display-name PC-01
claudefleet scan
claudefleet sync
```

> A browser cannot read `~/.claude/projects/*.jsonl` — sandboxing forbids it — so
> no dashboard button can scan a PC directly. The install command is the
> equivalent: one action, then it runs automatically.

### Local-only mode

The agent works with no server at all:

```bash
cd agent
python -m claudefleet scan     # ingest transcripts
python -m claudefleet today    # today's usage by model
python -m claudefleet week     # last 7 days
python -m claudefleet stats     # all-time
```

Local store: `~/.claude/claudefleet/usage.db` (override with `CLAUDEFLEET_DB`).

---

## Design

- **`event_id = "<system_id>:<message_id>"`** — globally unique, so re-scanning,
  re-syncing, or retrying after a failure can never double-count. Ingest is a
  single `INSERT … ON CONFLICT DO NOTHING`, which makes it atomic under
  concurrent syncs.
- **`usage_events` is the source of truth**; `daily_aggregates` is a rollup
  updated in the same transaction, so dashboards stay fast without drifting.
- **Two independent auth systems** — humans use Supabase JWTs (ES256, verified
  against Supabase's public JWKS); agents use `cfk_` keys stored as sha256
  hashes. Neither is accepted where the other belongs.
- **UTC everywhere internally**; local time only for display.
- **Offline-first agent** — sync failures leave local state untouched and retry
  on the next run.

---

## Tests

```bash
cd agent && python -m pytest             # 33 tests — parser, store, scanner, pricing
cd api   && node tests/e2e-smoke.mjs     # 30 checks — auth, dedup, RBAC, keys
cd api   && node tests/real-agent-flow.mjs  # full flow with the real agent
cd web   && npm run build                # type-check + production build
```

The API tests run against a live Supabase project and clean up after themselves.

---

## Deployment

See [docs/DEPLOY.md](docs/DEPLOY.md). Short version: connect the repo to Netlify,
set the four environment variables, deploy. One site serves both the dashboard
and the API.
