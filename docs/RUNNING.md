# Running Meterhouse

Three components: the **central server** (FastAPI), the **web dashboard** (React),
and the **agent** on each PC. Local-only usage needs just the agent.

## 1. Central server

```bash
cd server
python -m venv .venv && .venv\Scripts\activate      # Windows
pip install -e ".[dev]"

# One command — creates the DB + admin on first run, then serves on :8000:
python run.py

# (equivalent, if you prefer uvicorn directly / to set host+port:)
# uvicorn app.main:app --host 0.0.0.0 --port 8000
```

- On first run it creates the SQLite DB and seeds the four roles. You create the
  **first admin account from the web app** (`/register`), which is open only
  until the first user exists.
- Interactive API docs: `http://localhost:8000/docs`
- Config (all env, prefix `METERHOUSE_`): `DATABASE_URL`, `JWT_SECRET`,
  `ACCESS_TOKEN_EXPIRE_MINUTES`, `CORS_ORIGINS`.
- Tests: `pytest` (12 tests incl. RBAC scoping).

## 2. Web dashboard

```bash
cd web
npm install
npm run dev            # http://localhost:5173 (proxies /api to :8000)
```

On first visit, **create the admin account** (registration is open until the
first user exists). After signing in, name your first machine on the setup panel,
or go to **Admin → Agent API keys** to enroll systems and copy their keys.

**How other users log in:** the admin creates them under **Admin → Users &
roles** (email, password, role, and — for developers — assigned systems). Those
users then sign in at `/login` with the credentials the admin set; their role
decides what they can see (developers only their assigned systems).

Production build: `npm run build` → static files in `web/dist/` (serve behind
any static host / the FastAPI app).

## 3. Agent (per PC)

```bash
cd agent
# local mode (no server needed):
python -m meterhouse scan
python -m meterhouse today | week | stats

# central mode — register once with the key from the dashboard:
python -m meterhouse register --server http://SERVER:8000 --api-key cfk_... --display-name PC-01
python -m meterhouse scan       # ingest transcripts locally
python -m meterhouse sync        # push new events to the server
python -m meterhouse heartbeat   # liveness ping
```

Local overrides: `METERHOUSE_DB` (local DB path), `METERHOUSE_CONFIG` (identity/config path).

## End-to-end smoke test (one machine)

1. Start the server (port 8000).
2. `npm run dev`, create the admin account, then enroll a system and copy the key.
3. `meterhouse register --server http://127.0.0.1:8000 --api-key <key> --display-name PC-01`
4. `meterhouse scan && meterhouse sync`
5. Watch the dashboard populate. Re-running `sync` inserts 0 (idempotent).

## Verified so far

- Backend: **12 pytest tests pass** — auth, agent sync + dedup, dashboard
  aggregation, and RBAC scoping (developer cannot see unassigned systems,
  cannot manage users; viewer cannot admin; revoked key blocks sync; audit log).
- End-to-end on this machine: **1,787 real events** synced agent → API;
  re-sync reported `inserted=0, duplicates=1787` (no double counting).
