# Running Meterhouse

Three components: the **API** (Fastify + Drizzle on Supabase Postgres), the
**web dashboard** (React + Vite), and the **agent** on each PC. Local-only usage
needs just the agent — it has no dependency on the API.

A fourth, optional process — the **real-time WebSocket server** — is only needed
for live dashboard push. Everything works without it.

## 0. Prerequisites

- Node 22
- A Supabase project (Postgres + Auth). Supabase owns credentials; the API
  verifies its ES256 JWTs against the project's public JWKS.
- Python 3.11+ for the agent

```bash
npm install          # installs the web/ and api/ workspaces
cp api/.env.example api/.env
```

Fill in `api/.env` — at minimum `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Use the Supabase
**transaction pooler** URI (port 6543), not the direct `db.<ref>.supabase.co`
host: newer projects publish no DNS for direct connections, and serverless
functions exhaust them anyway.

## 1. API

```bash
cd api
npm run db:migrate       # apply Drizzle migrations (api/drizzle/*.sql)
npm run db:seed-admin    # create the first admin account
npm run dev              # tsx watch -> http://127.0.0.1:8000
```

- Migrations use `DIRECT_URL` (session-mode pooler) when set, because
  transaction mode rebinds a connection per statement and breaks multi-statement
  DDL.
- Config is validated once at boot (`api/src/config.ts`) and fails fast with a
  readable message rather than surfacing `undefined` inside a request handler.
- Tests: `npm test` (vitest).
- Inspect the database: `npm run db:studio`.

## 2. Web dashboard

```bash
cd web
npm run dev              # http://localhost:5173, proxies /api to :8000
```

The dev proxy mirrors the same-origin setup Netlify provides in production, so
there are no CORS hoops locally.

Sign in with the seeded admin account. Then either name your first machine on
the setup panel, or go to **Admin → Agent API keys** to enroll systems and copy
their keys.

**How other users get access:** an admin invites them under **Admin → Users &
roles** (email, role, and — for developers — assigned systems). Their role
decides what they see; a developer sees only their assigned systems.

Production build: `npm run build` → static files in `web/dist/`.

## 3. Agent (per PC)

```bash
cd agent
pip install -e ".[dev]"

# local mode (no API needed):
python -m meterhouse scan
python -m meterhouse today | week | stats

# central mode — register once with the key from the dashboard:
python -m meterhouse register --server http://SERVER:8000 --api-key cfk_... --display-name PC-01
python -m meterhouse scan        # ingest transcripts locally
python -m meterhouse sync        # push new events to the API
python -m meterhouse heartbeat   # liveness ping
```

Local overrides: `METERHOUSE_DB` (local DB path), `METERHOUSE_CONFIG`
(identity/config path).

## 4. Real-time server (optional)

Netlify Functions are stateless and cannot hold a socket open, so the WebSocket
server always runs as its own persistent process — locally, or on a host like
Railway/Fly/a VPS in production.

```bash
cd api
npm run ws-server        # ws://127.0.0.1:8787
```

Point the dashboard at it with `VITE_PUBLIC_WS_URL`, and the API with
`PUBLIC_WS_URL`. With both unset, real-time push is simply off and the
dashboard's existing polling keeps working unchanged.

## End-to-end smoke test (one machine)

1. `npm run dev` in `api/` (port 8000) and in `web/` (port 5173).
2. Sign in as the seeded admin, enroll a system, copy its key.
3. `meterhouse register --server http://127.0.0.1:8000 --api-key <key> --display-name PC-01`
4. `meterhouse scan && meterhouse sync`
5. Watch the dashboard populate. Re-running `sync` inserts 0 — ingestion is
   idempotent, so a repeated push cannot double-count.

There is also a scripted end-to-end check: `node api/tests/agent-e2e-safe.mjs`.

## Deploying

See [DEPLOY.md](DEPLOY.md) — the dashboard and API ship as a single Netlify site
(static files plus one serverless function on the same origin).
