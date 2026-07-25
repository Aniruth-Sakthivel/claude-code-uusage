# ClaudeFleet Agent — Install & Scan Guide

The agent scans Claude Code's local transcript files, stores usage in a local
SQLite database, and (optionally) syncs it to the central server. **Scanning
works fully offline — no server required.**

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
> `claudefleet` command from the repo, which needs **git** on `PATH` — see §7.

---

## 2. Install

Clone the repository and move into the agent folder:

```powershell
git clone <your-repo-url> claudefleet
cd claudefleet\agent
```

You can run it two ways:

**A. No install (simplest)** — run it as a module from the `agent/` folder:
```powershell
python -m claudefleet --help
```

**B. Install the `claudefleet` command** (so you can run it from anywhere):
```powershell
pip install -e .
claudefleet --help
```

Both are equivalent; the rest of this guide uses `python -m claudefleet`.

---

## 3. Run a scan

Give this machine a name (once), then scan:

```powershell
python -m claudefleet identity --display-name PC-01
python -m claudefleet scan
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
python -m claudefleet today     # today's tokens by model
python -m claudefleet week      # last 7 days
python -m claudefleet stats     # all-time totals, by model, top projects
```

`stats` example:

```
  ClaudeFleet - all-time tracked usage
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
| Usage database | `~/.claude/claudefleet/usage.db` | `CLAUDEFLEET_DB` |
| Machine identity/config | `~/.claude/claudefleet/agent.json` | `CLAUDEFLEET_CONFIG` |
| Transcripts it reads (read-only) | `~/.claude/projects/**/*.jsonl` | auto-discovered |

Example with a custom DB path (PowerShell):
```powershell
$env:CLAUDEFLEET_DB = "D:\data\usage.db"
python -m claudefleet scan
```

The agent **never modifies Claude Code's files** and never stores prompts,
responses, or source code — only token counts and metadata.

---

## 6. Automatic scanning (Windows Task Scheduler)

Run a scan every 15 minutes without thinking about it (one line):

```powershell
schtasks /Create /SC MINUTE /MO 15 /TN "ClaudeFleet Scan" /TR "python -m claudefleet scan --quiet" /ST 00:00
```

Remove it later with:
```powershell
schtasks /Delete /TN "ClaudeFleet Scan" /F
```

*(A packaged `install.ps1` that also wires up sync + heartbeat is planned; for now
the single line above covers local scanning.)*

---

## 7. Send data to the central server (optional)

Local scanning is enough for one machine. To feed a central dashboard:

1. Sign in to the web app and open **Connect PC** (or ask your admin for an API key).
2. On the PC, install the agent — **you do not need the full repository**:

```powershell
pip install claudefleet-agent
claudefleet register --server https://YOUR-DASHBOARD-URL --api-key cfk_... --display-name PC-01
claudefleet scan
claudefleet sync
```

Or use the Windows installer from the repo (`deploy/install.ps1`).

An administrator can also create an **API key** under Admin → Agent API keys, then share the key and dashboard URL with each user.

`sync` only sends events the server hasn't seen; if the server is down it simply
retries next time (nothing is lost, nothing is double-counted).

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `scan complete: new=0 ... events+=0` on first run | No transcripts found. Confirm `%USERPROFILE%\.claude\projects\` exists and you've used Claude Code. |
| `python` not found | Install Python 3.10+ and ensure it's on `PATH` (`py -3` also works on Windows). |
| Want a clean re-scan | Delete the usage DB (`%USERPROFILE%\.claude\claudefleet\usage.db`) and run `scan` again. |
| `sync` says "Central mode not configured" | Run `register` first with `--server` and `--api-key`. |
| `sync` fails / offline | Expected when the server is unreachable; it retries on the next run. |

---

## Command reference

```
python -m claudefleet scan       [--display-name NAME] [--quiet]
python -m claudefleet today | week | stats
python -m claudefleet identity   [--display-name NAME] [--set-display-name NAME]
python -m claudefleet register   --server URL --api-key KEY [--display-name NAME]
python -m claudefleet sync       [--quiet]
python -m claudefleet heartbeat
python -m claudefleet --version
```

Run the test suite with `pip install pytest && python -m pytest` (33 tests).
