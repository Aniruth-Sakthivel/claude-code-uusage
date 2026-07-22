# Deployment

ClaudeFleet has three parts with different hosting needs:

| Part | What it is | Where it runs |
|---|---|---|
| `web/` | React static site | **Netlify** (or any static host) |
| `server/` | FastAPI + DB (long-running) | **Render / Railway / Fly.io / a VM** — *not Netlify* |
| `agent/` | Per-PC scanner | On each PC (Windows Task Scheduler) |

> **Why not the backend on Netlify?** Netlify serves static files and short-lived
> serverless functions. It can't run a persistent uvicorn process, and it has no
> writable disk for SQLite. Host the API on a platform that runs a Python web
> service, then point Netlify's `/api/*` proxy at it.

---

## 1. Deploy the backend (do this first)

Any Python host works. General steps:

1. **Use Postgres, not SQLite**, for a real deployment (managed disks on PaaS are
   usually ephemeral). Add a driver and set the URL:
   ```bash
   pip install "psycopg[binary]"
   # env var on the host:
   CLAUDEFLEET_DATABASE_URL=postgresql+psycopg://user:pass@host:5432/claudefleet
   ```
2. **Set a strong secret:** `CLAUDEFLEET_JWT_SECRET=<random 32+ chars>`.
3. **Start command:** `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   (working directory = `server/`; the app creates tables + seeds roles on boot).
4. Note the public URL, e.g. `https://claudefleet-api.onrender.com`.

*(Example — Render: New Web Service → root `server/` → Build `pip install -e .` →
Start `uvicorn app.main:app --host 0.0.0.0 --port $PORT` → add the two env vars.)*

---

## 2. Deploy the frontend to Netlify

The repo already includes [`netlify.toml`](../netlify.toml).

1. Push the repo to GitHub/GitLab.
2. In Netlify: **Add new site → Import from Git**, pick the repo.
3. Build settings are read from `netlify.toml` automatically:
   - Base directory `web`, build `npm run build`, publish `web/dist`.
4. **Edit `netlify.toml`** — replace `YOUR-BACKEND-HOST` in the `/api/*` redirect
   with your backend URL from step 1, commit, and let Netlify redeploy.
5. Deploy. Your dashboard is live at `https://<your-site>.netlify.app`.

The `/api/*` proxy means the browser only ever calls the Netlify origin, so **no
CORS setup is needed**. (If you instead call the backend cross-origin directly,
add the Netlify URL to `CLAUDEFLEET_CORS_ORIGINS` on the backend.)

The SPA fallback redirect in `netlify.toml` makes `/login`, `/register`,
`/dashboard`, etc. survive a hard refresh.

---

## 3. First run

1. Open the Netlify URL → `/register` → create the admin account.
2. Sign in → name your first machine → copy its API key.
3. On each PC: `claudefleet register --server https://YOUR-BACKEND-HOST --api-key cfk_... --display-name PC-01`,
   then `claudefleet scan && claudefleet sync`.

---

## Alternative: one host for everything

If you'd rather not split hosting, serve the built frontend from FastAPI and
deploy the whole thing to a single Python host (no Netlify): run
`npm run build` and have FastAPI serve `web/dist` as static files, or put both
behind a reverse proxy (nginx/Caddy) on a VM. Netlify is only worth it when you
want the frontend on a fast CDN separate from the API.
