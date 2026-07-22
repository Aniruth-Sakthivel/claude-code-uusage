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
agent/     ✅ local agent — scanner, local SQLite store, CLI (this phase)
server/    ⏳ central API (FastAPI + SQLAlchemy)               [next phases]
web/       ⏳ central dashboard (React + Vite + TS)            [next phases]
deploy/    ⏳ Windows install/update scripts + Task Scheduler  [next phases]
docs/      audit (format spec) + centralization plan
```

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
cd agent && python -m pytest    # 33 tests (parser, store, scanner, pricing, identity)
```

See [docs/CENTRALIZATION_PLAN.md](docs/CENTRALIZATION_PLAN.md) for the roadmap and
[docs/UPSTREAM_AUDIT.md](docs/UPSTREAM_AUDIT.md) for the JSONL format reference.
