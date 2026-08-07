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

## 6. Running in the background (always-on)

**The agent is a single persistent process, scanning continuously** —
independent of whether Claude Code is open. There are no Claude Code session
hooks. Start it once:

```powershell
python -m meterhouse daemon
```

By itself this blocks the terminal — see below for running it detached and
keeping it alive across reboots, which the "Connect PC" flow (§7) sets up for
you automatically.

### The lifecycle

```
python -m meterhouse daemon  ->  scans every 5s (default), forever
                                  syncs immediately on new data, or every
                                  20s (default) otherwise, whichever comes first
stop command / SIGTERM       ->  final scan + sync  ->  reports "stopped"  ->  exits
```

Scanning and syncing run on independent cadences (`scan_interval_seconds` /
`sync_interval_seconds`, both remotely tunable from the dashboard): every tick
scans — cheap and incremental, since only changed files are re-read — but a
full network round trip only happens when a tick actually found something new,
or the sync interval has elapsed. This keeps detection latency tight without
hammering the server on a quiet machine.

Several Claude Code windows share one agent, and each OS user on a shared
machine gets their own — everything lives under `~/.claude/meterhouse/`.
Launching the agent while one is already running is safe: it takes a
single-instance lock (`~/.claude/meterhouse/daemon.lock`) and a duplicate
exits immediately — which is exactly what makes it safe for a scheduled task
to keep trying to (re)launch it on a timer (see below).

### Keeping it running: the scheduled task supervisor

A process that's supposed to run forever needs something to notice if it dies
and restart it. Register a Scheduled Task with a 1-minute repeating trigger —
every attempt while a daemon is already running is a harmless no-op that exits
in milliseconds, so this is safe to fire constantly:

```powershell
$py = (Get-Command python).Source
$pyw = Join-Path (Split-Path $py) 'pythonw.exe'   # no console window
$exe = if (Test-Path $pyw) { $pyw } else { $py }
$act = New-ScheduledTaskAction -Execute $exe -Argument '-m meterhouse daemon'
$logon = New-ScheduledTaskTrigger -AtLogOn
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Meterhouse Agent' -Action $act -Trigger @($logon, $repeat) -Force
Get-ScheduledTask -TaskName 'Meterhouse Agent'   # verify it actually registered
```

> No `-RepetitionDuration`: leaving it unset is what makes the repeat
> indefinite. Passing `[TimeSpan]::MaxValue` there looks like "forever", but
> Task Scheduler serializes triggers as an ISO 8601 duration, and MaxValue
> overflows what that format can represent — the task registers without
> error and then fails on every attempt to *run*, with "The task XML
> contains a value which is incorrectly formatted or out of range". That
> failure is silent at registration time, which is what made it easy to
> ship undetected.

`deploy/install.ps1` and the dashboard's generated setup script both do this
for you, plus starting the daemon immediately so the machine doesn't wait for
the first trigger.

### Checking on it

```powershell
python -m meterhouse status   # is a daemon running, and what it last reported
python -m meterhouse health   # full diagnostics: scan counts, WS state, offline queue
```

The agent reports each step to the dashboard as it happens (`scanning` →
`scanned` → `syncing` → `idle`). A machine showing **Idle/Working** is the
normal state; **Stopped** now means someone deliberately stopped it (a
dashboard `stop` command, or uninstall) — not something to expect routinely.
Its log is at `~/.claude/meterhouse/agent.log` (rotating) — the agent runs
windowless, so this is where its output goes.

### Turning it off

```powershell
python -m meterhouse stop
schtasks /Delete /TN "Meterhouse Agent" /F
```

`stop` alone only stops the current process — the scheduled task relaunches it
within about a minute unless you also remove the task.

---

## 7. Send data to the central server (optional)

Local scanning is enough for one machine. To feed a central dashboard:

1. Sign in to the web app and open **Connect PC** (or ask your admin for an API key).
2. The web app generates a one-line setup command for the machine you want to track.
   This is the command you run in PowerShell on that PC.
3. The command installs the agent, registers the machine with the server, scans local
   Claude Code transcripts, syncs the results back to the dashboard, starts the
   agent, and (on Windows) registers the scheduled task that keeps it running.

If you only have the website link, that is enough. The site does not scan your PC
from the browser; it only generates the install/connect command and gives you the
server URL and API key to use.

**One command does the rest** (register, first scan, first sync, start the daemon,
and — on Windows — register the scheduled task supervisor):

```powershell
pip install meterhouse-rotor
meterhouse connect --server https://YOUR-API-URL --api-key cfk_... --display-name PC-01
```

Add `--account` to also turn on Claude account reporting (see §8) in the same
step, and `--ws-url wss://YOUR-WS-URL` to enable real-time push.
`meterhouse status` afterward confirms it took.

Or run each step yourself:

```powershell
pip install meterhouse-rotor
meterhouse register --server https://YOUR-API-URL --api-key cfk_... --display-name PC-01
meterhouse scan
meterhouse sync
meterhouse daemon   # or let `connect` above start + supervise it for you
```

Or use the Windows installer from the repo (`deploy/install.ps1`), which does
everything `connect` does, starts the agent, and registers the scheduled task that
keeps it running.

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
python -m meterhouse connect    --server URL --api-key KEY [--display-name NAME] [--account] [--ws-url URL]
                                 # register + scan + sync + start daemon (+ scheduled task on Windows), one command
python -m meterhouse sync       [--quiet]
python -m meterhouse once       [--quiet]   # scan + sync + run queued commands
python -m meterhouse daemon     [--display-name NAME]   # run continuously
python -m meterhouse status                 # is a daemon running, last-known state
python -m meterhouse stop                   # stop a locally running daemon
python -m meterhouse health                 # full diagnostics snapshot
python -m meterhouse heartbeat
python -m meterhouse account   [show | enable | disable]
python -m meterhouse --version
```

### Claude account reporting (off by default in the agent; on by default from Connect a PC)

`account` controls whether this machine also reports which Claude
subscription it is signed into, so an admin can see who is on which plan and
how much of its rate limit is used. The agent itself defaults this off — a
plain `pip install` + `register` + `sync` never reports it. The dashboard's
"Connect a PC" one-liner turns it on explicitly, as one visible step of doing
everything in a single command; `account disable` opts back out on that PC at
any time, no reinstall needed.

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
