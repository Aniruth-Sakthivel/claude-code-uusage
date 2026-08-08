# Deployment

Meterhouse deploys as **one Netlify site**. The dashboard is served as static
files and the API runs as a serverless function on the same origin, so there is
no second host to pay for and no CORS to configure.

| Part | What it is | Where it runs |
|---|---|---|
| `web/` | React dashboard | Netlify (static) |
| `api/` | Fastify API | Netlify Functions |
| Database | Postgres | Supabase |
| `agent/` | Per-PC scanner | Each PC (Windows Task Scheduler) |

---

## 1. Prepare Supabase

From your project dashboard:

**Settings → API**
- `SUPABASE_URL` — the project URL
- `SUPABASE_ANON_KEY` — publishable key
- `SUPABASE_SERVICE_ROLE_KEY` — secret key (server-only, never sent to browsers)

**Connect → Transaction pooler** (port **6543**)
- `DATABASE_URL`

> **Use the pooler, not `db.<ref>.supabase.co`.** Newer Supabase projects publish
> no DNS at all for direct connections. Even where they do, each serverless
> invocation opens its own backend connection and exhausts the limit. The
> transaction pooler multiplexes them.

**Connect → Session pooler** (port **5432**)
- `DIRECT_URL` — used only for migrations, which need a stable session for DDL.

### Email settings

Admins invite users by email. If your project has no SMTP configured, either set
one up under **Authentication → Emails**, or create accounts with an explicit
password (the "Set a password instead" option on the invite form).

#### Invite email template

Every invited account is created with a default password (`Dreams@99`, override
with the `INVITE_DEFAULT_PASSWORD` environment variable) and a pre-confirmed
email address, so the person can sign in immediately with their own email
address — the link is only needed if they want to choose their own password.

The API passes those details to Supabase as invite metadata, but the email body
lives in the dashboard: **Authentication → Emails → Invite user**. Paste in
[invite-email-template.html](invite-email-template.html) (reproduced below) so
the credentials actually appear — Supabase's stock body shows only a link:

```html
<h2>You have been invited to Meterhouse</h2>

<p>An administrator has created an account for you. Sign in with:</p>

<table>
  <tr><td><strong>Email</strong></td><td>{{ .Data.default_email }}</td></tr>
  <tr><td><strong>Password</strong></td><td>{{ .Data.default_password }}</td></tr>
</table>

<p><a href="{{ .ConfirmationURL }}">Accept the invitation and set your own password</a></p>

<p>Please change the default password after your first sign-in.</p>
```

`{{ .Data.* }}` reads the invite metadata (`default_email`, `default_password`,
`full_name`) set in `api/src/core/supabase-admin.ts` — renaming those keys means
editing this template to match. Sending a shared starter password by email is a
deliberate trade-off for onboarding convenience; treat it as a first-login
credential, not a secret.

---

## 2. Apply migrations

Run once from your machine, against the production database:

```bash
cd api
DIRECT_URL="postgresql://...:5432/postgres" npm run db:migrate
```

This creates the ten tables, indexes, and seeds the four roles. It is idempotent
— re-running applies only new migrations.

---

## 3. Deploy to Netlify

1. Push the repo to GitHub/GitLab.
2. Netlify → **Add new site → Import from Git**.
3. Build settings come from [`netlify.toml`](../netlify.toml) automatically:
   - build `npm run build`, publish `web/dist`, functions in `netlify/functions`
4. **Site configuration → Environment variables** — add:

   ```
   DATABASE_URL                 (transaction pooler, port 6543)
   SUPABASE_URL
   SUPABASE_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY
   NODE_ENV=production
   ```

   The dashboard also needs its build-time pair:

   ```
   VITE_SUPABASE_URL
   VITE_SUPABASE_ANON_KEY
   ```

5. Deploy.

`PUBLIC_URL` is optional — Netlify sets `URL` automatically, and the generated
install scripts use it so agents point at the right origin.

### Verify

```bash
curl https://your-site.netlify.app/api/v1/health
# {"status":"ok","service":"meterhouse","version":"1.0.0","database":"ok"}
```

A `database` value other than `ok` means `DATABASE_URL` is wrong or the pooler is
unreachable.

---

## 4. First run

1. Open the site → **Create the admin account**. The first user to sign up
   becomes administrator; registration then closes automatically.
2. **Connect a PC** → copy the one-line command → run it in PowerShell on the
   machine you want to track.
3. Usage appears on the dashboard after the first sync (within ~15 minutes, or
   immediately since the install script runs a scan itself).

---

## 5. Roll out to more PCs

Each user signs in and uses **Connect a PC** themselves — this works for every
role, including developers, so onboarding does not require an admin.

Administrators can alternatively pre-create machines and share keys from
**Admin → Agent API keys**.

Each install runs a single always-on `meterhouse daemon` process that scans
continuously — not gated by Claude Code sessions. A scheduled task (`Meterhouse
Agent`) is registered as a supervisor: if the daemon process ever exits, the
task relaunches it within about a minute. To stop the agent on a PC for good
(uninstalling it), stop the daemon and remove the scheduled task:

```powershell
python -m meterhouse stop
schtasks /Delete /TN "Meterhouse Agent" /F
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `health` reports `database: error` | `DATABASE_URL` wrong, or using the direct host instead of the pooler. |
| `Tenant or user not found` | Wrong pooler region. Copy the exact URI from **Connect**. |
| Function times out on first request | Cold start plus a slow first connection. The configured timeout is 26s; retry. |
| A PC stops reporting when the user closes the terminal | This is expected — `meterhouse connect` starts the daemon windowless and detached from any console, so it keeps running after the terminal closes. If it's actually gone, re-run the "Connect this PC" one-liner. |
| The dashboard shows **stalled** or **dead**, and "Restart agent" from Agent controls does nothing | The agent is genuinely hung, not just offline — a queued command (including Restart) only takes effect once the agent checks in on its own, so it can't unstick a stuck process. On that PC, run `meterhouse stop`. It kills the process directly by PID from its lock file (works fully offline), and the scheduled task relaunches the daemon automatically within about a minute. Confirm with `meterhouse status`. |
| A PC never leaves **Idle**/**never synced** even while in use | The daemon isn't running. Run `meterhouse status` on that PC to check; if nothing is running, re-run the "Connect this PC" one-liner (or `meterhouse daemon` directly) to start it. |
| "Scan now" from Agent controls does nothing | Commands are collected on the agent's next check-in — check the Systems page's scan activity to see when that's due. If the agent is stalled/dead rather than just running behind, see the row above. |
| Systems page shows "No report" | The agent has not reported a state in the last 10 minutes and did not report stopping — so it was likely killed rather than exiting cleanly. Run `meterhouse status` on that PC for its last known state. |
| Invite emails never arrive | No SMTP configured in Supabase. Use the "set a password" option, or configure SMTP. The account still works — the default password is set regardless of whether the mail is delivered. |
| Invite email shows no login details | The dashboard template still has Supabase's default body. Paste the template from "Invite email template" above. |
| `unrecognized JWT kid` on user creation | Transient GoTrue error, retried automatically. Persisting means email confirmation is failing — check Supabase auth settings. |
| Dashboard shows zeros | No agent has synced yet. Check **Systems** for "Never synced". |
| Agent `scan` finds 0 events | No Claude Code transcripts on that PC — confirm `%USERPROFILE%\.claude\projects\` exists. |

---

## Alternative hosts

Nothing is Netlify-specific except [`netlify.toml`](../netlify.toml) and
[`netlify/functions/api.mts`](../netlify/functions/api.mts). To run the API as a
normal long-lived process instead:

```bash
cd api && npm run build && node dist/server.js
```

Serve `web/dist` from any static host and proxy `/api/*` to it. On a persistent
host you can use the **session** pooler (port 5432) for the runtime connection
too, and raise `max` in [`api/src/db/client.ts`](../api/src/db/client.ts).
