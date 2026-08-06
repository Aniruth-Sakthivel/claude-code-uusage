# Meterhouse

> Centralized Claude Code usage monitoring across multiple PCs.

Meterhouse answers one question across a fleet of machines:

> **Which PC is generating the most Claude Code token activity?**

It reads the JSONL transcript files Claude Code already writes on each PC, stores
usage locally in SQLite, and syncs the metadata to a central API + dashboard.

> **Tracked activity ≠ official quota.** All numbers are token counts parsed from
> local transcript files — an observability *estimate*, not a reading of
> Anthropic's official Claude Max/Pro quota or billing.

**Privacy:** by default, only token counts and metadata ever leave a machine.
Never prompts, responses, or source code. The agent never modifies Claude
Code's files.

**Optional account reporting (off by default).** The agent can additionally
report your Claude account's non-secret identity — email, organisation, plan
tier — and the rate-limit utilisation figures Claude Code already caches, so an
admin can see which subscription each person is on and how loaded it is. This
is the one feature that reads `~/.claude.json`, it is governed by a hardcoded
field allowlist, and **OAuth tokens and credentials are never read**
(`.credentials.json` is never opened). It stays off until someone turns it on:

```bash
meterhouse account show      # print exactly what would be sent — sends nothing
meterhouse account enable    # opt in
meterhouse account disable   # opt back out
```

Inspect the allowlist in `agent/meterhouse/account.py`; the guarantees are
enforced by tests in `agent/tests/test_account.py`.

---

## Layout

```
agent/    Rotor — the metering agent (Python, stdlib only): scanner, store, sync, CLI
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

Optionally override the default admin credentials with `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `api/.env` before seeding (see
[Default admin account](#default-admin-account)).

> Use the **pooler**, not `db.<ref>.supabase.co`. Newer Supabase projects publish
> no DNS for direct connections, and serverless functions exhaust them anyway.

### 2. Install and migrate

```bash
npm install            # installs api/ and web/ (npm workspaces)
npm run db:migrate     # creates the schema and seeds roles
npm run db:seed-admin  # creates the single default admin account
```

### 3. Run

```bash
npm run dev          # API on :8000, dashboard on :5173
```

Open **http://localhost:5173**:

1. **Sign in as the default admin** — see
   [Default admin account](#default-admin-account) below, then change the
   password.
2. **Connect this PC** — copy the single generated command, run it in PowerShell.
   It installs the agent, registers the machine, scans, syncs, and wires Claude
   Code's session hooks so the agent runs only while you have a session open.
3. Usage appears on the dashboard after the first sync.

### Default admin account

`npm run db:seed-admin` provisions **one** administrator — the only account that
exists on a fresh install:

| Field | Value |
|---|---|
| Email | `admin@meterhouse.local` |
| Password | `Admin@2026!` |
| Role | Administrator |

> **Change this password on first sign-in** (**Admin → Users & roles → edit**).
> The default is published here, so it is public knowledge.

Override the credentials before seeding by setting them in `api/.env`:

```bash
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<a strong password>
ADMIN_FULL_NAME=Administrator
```

The command is idempotent — re-running it reuses the existing Supabase Auth
identity, re-asserts the admin role, and resets the password to the configured
value. Use it to recover locked-out access instead of creating a second admin.

All other accounts are created by this admin; self-registration is closed once a
user exists.

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
pip install meterhouse-rotor
meterhouse register --server https://your-site --api-key cfk_... --display-name PC-01
meterhouse scan
meterhouse sync
```

> A browser cannot read `~/.claude/projects/*.jsonl` — sandboxing forbids it — so
> no dashboard button can scan a PC directly. The install command is the
> equivalent: one action, then it runs automatically.

### Local-only mode

The agent works with no server at all:

```bash
cd agent
python -m meterhouse scan     # ingest transcripts
python -m meterhouse today    # today's usage by model
python -m meterhouse week     # last 7 days
python -m meterhouse stats     # all-time
```

Local store: `~/.claude/meterhouse/usage.db` (override with `METERHOUSE_DB`).

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
