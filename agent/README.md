# Rotor — Install & Scan Guide

**Rotor** is the Meterhouse metering agent: the part that sits on each machine
and turns as work happens. It scans Claude Code's local transcript files, stores
usage in a local SQLite database, and (optionally) syncs it to the central
server. **Scanning works fully offline — no server required.**

Installed as `meterhouse-rotor`; the command it provides is `meterhouse`.

> **Tracked activity ≠ official quota.** All numbers are token counts parsed from
> local transcripts — an estimate, not your Claude Max/Pro billing or quota.

---

## 1. Prerequisites

- **Python 3.10+** (check with `python --version`)
- **Claude Code** installed and used at least once on this machine, so transcripts
  exist under `~/.claude/projects/` (Windows: `%USERPROFILE%\.claude\projects\`).

The agent uses **only the Python standard library** — there is nothing to
`pip install` for scanning.

> For **central mode** (sending usage to the dashboard) you install the
> `meterhouse` command from the repo, which needs **git** on `PATH` — see §7.

---

## 2. Install

Clone the repository and move into the agent folder:

```powershell
git clone <your-repo-url> meterhouse
cd meterhouse\agent
```

You can run it three ways:

**A. Install from PyPI (public release)** — once published, users can install:
```powershell
pip install meterhouse-rotor
```

**B. No install (simplest)** — run it as a module from the `agent/` folder:
```powershell
python -m meterhouse --help
```

**C. Install the `meterhouse` command locally** (so you can run it from anywhere):
```powershell
pip install -e .
meterhouse --help
```

Both install options are equivalent for command usage; the rest of this guide uses `python -m meterhouse`.

> The package is now public-ready as `meterhouse-rotor`. If the package has already been published on PyPI, use the `pip install meterhouse-rotor` command above.

---

## 3. Use the agent as a Python SDK

The package now exposes a simple SDK interface via `meterhouse.Agent`.

### Install the package

```powershell
pip install -e .
```

### Example usage

```python
from meterhouse import Agent

agent = Agent(display_name="PC-01")
agent.register(
    server_url="http://127.0.0.1:8000",
    api_key="cfk_...",
    display_name="PC-01",
)
print(agent.scan())
print(agent.sync())
print(agent.health())
```

The SDK also supports running the daemon programmatically:

```python
agent = Agent(display_name="PC-01")
agent.daemon()
```

---

## 4. Run a scan

Give this machine a name (once), then scan:

```powershell
python -m meterhouse identity --display-name PC-01
python -m meterhouse scan
```

Example output:

```
  [NEW] C:\Users\you\.claude\projects\my-proj\<uuid>.jsonl  (+266 events)
  ...
scan complete: new=18 updated=0 skipped=0 events+=1787
```

The scan is **incremental and idempotent**:
- Unchanged files are skipped; changed files are read only from where they left off.
- Running it again processes nothing new (`events+=0`) — it never double-counts.

Run `scan` whenever you want fresh data (or schedule it — see §6).

---

## 4. View your usage

```powershell
python -m meterhouse today     # today's tokens by model
python -m meterhouse week      # last 7 days
python -m meterhouse stats     # all-time totals, by model, top projects
```

`stats` example:

```
  Meterhouse - all-time tracked usage
  Sessions:       13
  Input tokens:   6.2M   Output tokens: 1.1M   Cache read: 280M ...
  By model:  claude-opus-4-8  ...  claude-sonnet-5 ...
  Top projects:  Github/hotel-demo  ...
  (estimate only - not official Max/Pro quota)
```

---

## 5. Where your data lives

| What | Default location | Override with |
|---|---|---|
| Usage database | `~/.claude/meterhouse/usage.db` | `METERHOUSE_DB` |
| Machine identity/config | `~/.claude/meterhouse/agent.json` | `METERHOUSE_CONFIG` |
| Transcripts it reads (read-only) | `~/.claude/projects/**/*.jsonl` | auto-discovered |

Example with a custom DB path (PowerShell):
```powershell
$env:METERHOUSE_DB = "D:\data\usage.db"
python -m meterhouse scan
```

The agent **never modifies Claude Code's files** and never stores prompts,
responses, or source code — only token counts and metadata.

---

## 6. Running in the background (Windows Task Scheduler)

The "Connect PC" flow (§7) registers two tasks. Nothing has to stay open, and
closing the terminal you installed from does not stop anything:

| Task | What it does |
| --- | --- |
| **Meterhouse Agent** | The daemon: scans on its interval, scans immediately when you start using Claude, holds the real-time connection. Starts at logon and is re-checked every 5 minutes, so a daemon that was killed comes back on its own. |
| **Meterhouse Scan+Sync** | `meterhouse once` every 15 minutes. The fallback for machines where the daemon cannot stay running — usage keeps arriving, and commands queued from the dashboard still get collected. |

Re-launching the daemon while one is already running is safe: it takes a
single-instance lock (`~/.claude/meterhouse/daemon.lock`) and a duplicate exits
immediately.

### Scanning starts when you do

The scan interval is a floor, not a fixed cadence. While waiting it out the
daemon checks `~/.claude/projects` every few seconds, and the moment a
transcript is written — that is, the moment you start working in Claude Code —
it scans. Starting a session just after a tick therefore shows up on the
dashboard in seconds rather than a full interval later.

The daemon also reports each step to the dashboard as it happens (`scanning` →
`scanned` → `syncing` → `idle`), which is what the Systems page shows as a live
badge and next-scan countdown. `meterhouse health` reports the same state
locally; its `updated_at` is refreshed every 30 seconds regardless of the scan
interval, so a fresh timestamp always means a live process.

To set one up by hand, schedule `meterhouse once` — a single process that
scans, syncs, and runs any queued dashboard commands:

```powershell
$py  = (Get-Command python).Source
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'   # no console window
$exe = if (Test-Path $pyw) { $pyw } else { $py }
$act = New-ScheduledTaskAction -Execute $exe -Argument '-m meterhouse once --quiet'
$trg = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName 'Meterhouse Scan+Sync' -Action $act -Trigger $trg -Force
```

> Do not chain `scan && sync` in a task action. `schtasks /TR` does not go
> through `cmd.exe`, and wrapping it in `cmd /c "…"` needs nested quoting that
> frequently registers a task which never actually runs — a PC that silently
> stops reporting. `once` exists so there is nothing to chain.

### Stop the agent from scanning

```powershell
schtasks /Delete /TN "Meterhouse Agent" /F
schtasks /Delete /TN "Meterhouse Scan+Sync" /F
```

To pause instead (keeps run history, easy to re-enable):

```powershell
schtasks /Change /TN "Meterhouse Agent" /DISABLE
schtasks /Change /TN "Meterhouse Agent" /ENABLE   # resume later
```

---

## 7. Send data to the central server (optional)

Local scanning is enough for one machine. To feed a central dashboard:

1. Sign in to the web app and open **Connect PC** (or ask your admin for an API key).
2. The web app generates a one-line setup command for the machine you want to track.
   This is the command you run in PowerShell on that PC.
3. The command installs the agent, registers the machine with the server, scans local
   Claude Code transcripts, and syncs the results back to the dashboard.

If you only have the website link, that is enough. The site does not scan your PC
from the browser; it only generates the install/connect command and gives you the
server URL and API key to use.

```powershell
pip install meterhouse-rotor
meterhouse register --server https://YOUR-API-URL --api-key cfk_... --display-name PC-01
meterhouse scan
meterhouse sync
```

Or use the Windows installer from the repo (`deploy/install.ps1`), which does
all four steps above and sets up the recurring scan+sync task automatically.

> `--server` must be the **API** server (e.g. `http://localhost:8000` in dev),
> not the dashboard's frontend URL (`http://localhost:5173/...`). Pointing it
> at the frontend URL will fail to register.

The agent connects by calling the server at the given API URL and authenticating
with the supplied API key. After registration, it reads local transcript files,
aggregates token events, and sends only usage metadata to the dashboard.

An administrator can also create an **API key** under Admin → Agent API keys, then share the key and API URL with each user.

`sync` only sends events the server hasn't seen; if the server is down it simply
retries next time (nothing is lost, nothing is double-counted). The dashboard
shows a system as **"Never synced"** until the first successful `sync` call —
registering alone, or running `scan` without `sync`, is not enough.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `scan complete: new=0 ... events+=0` on first run | No transcripts found. Confirm `%USERPROFILE%\.claude\projects\` exists and you've used Claude Code. |
| `python` not found | Install Python 3.10+ and ensure it's on `PATH` (`py -3` also works on Windows). |
| Want a clean re-scan | Delete the usage DB (`%USERPROFILE%\.claude\meterhouse\usage.db`) and run `scan` again. |
| `sync` says "Central mode not configured" | Run `register` first with `--server` and `--api-key`. |
| `sync` fails / offline | Expected when the server is unreachable; it retries on the next run. |

---

## Command reference

```
python -m meterhouse scan       [--display-name NAME] [--quiet]
python -m meterhouse today | week | stats
python -m meterhouse identity   [--display-name NAME] [--set-display-name NAME]
python -m meterhouse register   --server URL --api-key KEY [--display-name NAME]
python -m meterhouse sync       [--quiet]
python -m meterhouse once       [--quiet]   # scan + sync + run queued commands
python -m meterhouse daemon     [--display-name NAME]
python -m meterhouse health
python -m meterhouse heartbeat
python -m meterhouse account   [show | enable | disable]
python -m meterhouse --version
```

### Claude account reporting (optional, off by default)

`account` controls whether this machine also reports which Claude
subscription it is signed into, so an admin can see who is on which plan and
how much of its rate limit is used.

```
python -m meterhouse account show      # print the exact payload - sends nothing
python -m meterhouse account enable
python -m meterhouse account disable
```

Enabled, the agent reads a fixed allowlist of fields from `~/.claude.json`:
account UUID, email, display name, organisation, plan tier, and the cached
rate-limit percentages. **OAuth tokens and credentials are never read**, and
`.credentials.json` is never opened. See `meterhouse/account.py` for the
allowlist and `tests/test_account.py` for the tests that enforce it.

Equivalent env var: `METERHOUSE_ACCOUNT_REPORTING=true`.

Run the test suite with `pip install pytest && python -m pytest`.
