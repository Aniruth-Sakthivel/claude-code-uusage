# JSONL Format Reference — audited from `phuryn/claude-usage`

> **Status update:** ClaudeFleet is **original software** and does **not** reuse or
> depend on `phuryn/claude-usage`. That project's code was removed. This document
> is retained as a **format reference**: a study of how Claude Code stores usage
> data on disk (the JSONL layout, field names, dedup semantics) — knowledge that
> describes *Claude Code's own data format*, not anyone's implementation. Our
> scanner (`agent/claudefleet/`) was written from scratch against this format and
> verified independently on real transcripts.
>
> **Original purpose (historical):** Deep audit performed before deciding whether to
> reuse the project. It informed our clean-room design; we ultimately wrote our own.

| | |
|---|---|
| **Repository** | https://github.com/phuryn/claude-usage |
| **Audited commit** | `3eea154474e93761f774ed38beeaf45baf838a45` |
| **Version** | **v1.5.5** (release 2026-07-10) — `scanner.VERSION` |
| **License** | MIT (Paweł Huryn) |
| **Runtime deps** | **None** — pure Python stdlib (`sqlite3`, `http.server`, `json`, `glob`, `pathlib`) |
| **Python** | `requires-python >= 3.8` (verified running under 3.14.4) |
| **Verification** | `python -m pytest tests/` → **147 passed**; real `python cli.py scan` on this machine ingested 18 files / 1752 turns / 13 sessions |

> **Tracked activity ≠ official quota.** Everything here measures token counts parsed from local Claude Code transcript files. These numbers are an *observability estimate*, not a reading of Anthropic's official Claude Max/Pro quota consumption or billing. The centralized platform must keep this distinction explicit in all UI copy.

---

## 1. Current architecture

Flat, three-module Python application plus a TypeScript VS Code extension that embeds it.

```
Claude Code (CLI / VS Code ext / Xcode) writes JSONL transcripts
        │
        ▼
~/.claude/projects/**/*.jsonl        (+ Xcode CodingAssistant dir)
        │  glob, incremental
        ▼
scanner.py  ── parse_jsonl_file() → aggregate_sessions() → upsert/insert
        │
        ▼
SQLite  ~/.claude/usage.db   (5 tables; env override CLAUDE_USAGE_DB)
        │
        ├── cli.py      today / week / stats  (read-only SQL aggregations, printed)
        └── dashboard.py  ThreadingHTTPServer :8080 → /api/data JSON + embedded HTML/Chart.js
```

- **Three top-level modules**, no package dir (`pyproject.toml → py-modules = ["cli","scanner","dashboard"]`). Console entry point `claude-usage = cli:main`.
- **`scanner.py`** (`scanner.py:1-832`) — discovery, JSONL parsing, schema, incremental ingest. The reusable core.
- **`cli.py`** (`cli.py:1-499`) — command dispatch, pricing/cost, text reports.
- **`dashboard.py`** (~2300 lines) — HTTP server + one big embedded `HTML_TEMPLATE` (Chart.js 4.4.0). Aggregation SQL in `get_dashboard_data()` (`dashboard.py:27`).
- **`vscode-extension/`** — TypeScript; spawns `python cli.py dashboard --no-browser` and renders it in a webview.

---

## 2. Scanner architecture (`scanner.py`)

Key module constants (`scanner.py:18-27`):

```python
VERSION = "1.5.5"
PROJECTS_DIR       = Path.home() / ".claude" / "projects"
XCODE_PROJECTS_DIR = Path.home() / "Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/projects"
DB_PATH            = Path(os.environ.get("CLAUDE_USAGE_DB", Path.home()/".claude"/"usage.db"))
DEFAULT_PROJECTS_DIRS = [PROJECTS_DIR, XCODE_PROJECTS_DIR]
MODEL_PRIORITY = {"fable":5, "mythos":5, "opus":3, "sonnet":2, "haiku":1}
```

Entry point `scan(projects_dir=None, projects_dirs=None, db_path=DB_PATH, verbose=True)` (`scanner.py:576`):

1. `get_db()` + `init_db()` (create/migrate schema).
2. Resolve dirs (explicit `projects_dirs` > single `projects_dir` > defaults).
3. `glob.glob(str(d/"**"/"*.jsonl"), recursive=True)` per existing dir, then `sort()`.
4. One-time topic backfill (gated by `schema_meta.topic_backfill_done`).
5. Per file: stat mtime → compare to `processed_files` → skip / full-parse (new) / tail-parse (updated).
6. After ingest, **recompute session totals from `turns`** (`scanner.py:800-809`) — the correctness backstop.

The scanner is a **batch, idempotent, read-only-on-transcripts** process. It never writes to or deletes Claude Code's files.

---

## 3. JSONL parsing flow

`parse_jsonl_file(filepath)` (`scanner.py:317-449`) returns `(session_metas, turns, agents, line_count)`.

Per line: `strip()` → skip blank → `json.loads` → keep only `type ∈ {assistant, user, custom-title, ai-title}` → require `record["sessionId"]`.

- **`custom-title` / `ai-title`** → session topic (`_extract_title`, `scanner.py:161`). custom-title always wins; ai-title only if no custom-title.
- **`user`** → may carry a `toolUseResult` closing an Agent/Task dispatch → `extract_agent_dispatch` (`scanner.py:263`) → `agents` table.
- **`assistant`** → the token-bearing record. Reads `record["message"]["usage"]`, `["model"]`, `["id"]`.
- **Session metadata** (project/first/last timestamp/git branch) updated from any qualifying record.

The tail-parse path in `scan()` (`scanner.py:649-788`) inlines the same parsing logic but only over lines beyond `old_lines`.

---

## 4. Database schema (exact DDL — `scanner.py:50-131`)

**`sessions`** — one row per Claude Code session (aggregated):
```sql
session_id TEXT PRIMARY KEY, project_name TEXT, first_timestamp TEXT, last_timestamp TEXT,
git_branch TEXT, total_input_tokens INTEGER DEFAULT 0, total_output_tokens INTEGER DEFAULT 0,
total_cache_read INTEGER DEFAULT 0, total_cache_creation INTEGER DEFAULT 0,
model TEXT, turn_count INTEGER DEFAULT 0, topic TEXT
```

**`turns`** — the granular per-message usage event table (**central to sync**):
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, timestamp TEXT, model TEXT,
input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
cache_read_tokens INTEGER DEFAULT 0, cache_creation_tokens INTEGER DEFAULT 0,
tool_name TEXT, cwd TEXT, message_id TEXT, is_subagent INTEGER DEFAULT 0, agent_id TEXT
```

**`processed_files`** — incremental scan watermark:
```sql
path TEXT PRIMARY KEY, mtime REAL, lines INTEGER
```

**`agents`** — subagent dispatch metadata:
```sql
agent_id TEXT PRIMARY KEY, agent_type TEXT, dispatched_in_session TEXT, completed_at TEXT,
status TEXT, total_tokens INTEGER, total_duration_ms INTEGER, tool_use_count INTEGER
```

**`schema_meta`** — `key TEXT PRIMARY KEY, value TEXT` (migration/backfill flags).

**Indexes:** `idx_turns_session`, `idx_turns_timestamp`, `idx_sessions_first`, `idx_agents_type`, `idx_turns_subagent`, `idx_turns_agent_id`, and the critical
```sql
CREATE UNIQUE INDEX idx_turns_message_id ON turns(message_id)
  WHERE message_id IS NOT NULL AND message_id != '';
```

### Migration logic
- `init_db()` is **idempotent**: `CREATE ... IF NOT EXISTS` + additive `_ensure_column()` (`scanner.py:134`) guarded `ALTER TABLE`.
- Read commands (`cli.require_db`, `cli.py:82`) and the dashboard also call `init_db()` on open, so a stale DB is migrated before any query (fixes "no such column" crashes; v1.5.5).
- Topic backfill (`_backfill_topics`, `scanner.py:171`) runs once, gated by `schema_meta`, and never touches token totals.
- **Implication for us:** the additive-migration + `schema_meta` pattern is the model to follow for any local-DB additions (e.g. a sync-watermark table) — no rebuilds, no data loss.

---

## 5. Incremental scan strategy (`scanner.py:615-795`)

For each globbed file:
1. `mtime = os.path.getmtime(path)` (OSError → skip).
2. Look up `processed_files` row.
3. **Skip** if `row and abs(row["mtime"] - mtime) < 0.01` (unchanged).
4. **New file** (no row): full `parse_jsonl_file`, ingest, record `(path, mtime, line_count)`.
5. **Updated file** (row exists, mtime differs): open once, `enumerate(f, 1)`, `continue` while `line_count <= old_lines`, parse only the tail.
   - If the file didn't actually grow (`line_count <= old_lines`), just bump the stored mtime and skip.
6. `INSERT OR REPLACE INTO processed_files(path, mtime, lines)` after processing.

The watermark is **(mtime, line count)** per absolute path — a simple, proven, hash-free approach.

---

## 6. Token extraction logic (`scanner.py:405-411`)

From `assistant` record `message.usage`:
```python
input_tokens   = usage.get("input_tokens", 0) or 0
output_tokens  = usage.get("output_tokens", 0) or 0
cache_read     = usage.get("cache_read_input_tokens", 0) or 0
cache_creation = usage.get("cache_creation_input_tokens", 0) or 0
# turn dropped entirely if all four sum to 0
```
`tool_name` = first `content[]` item with `type == "tool_use"`. These four counters + tool_name + model + message_id + subagent flags become a `turn` dict.

---

## 7. Session identification

- **Session id** = `record["sessionId"]` verbatim (`scanner.py:345`). Records without it are skipped.
- Sessions aggregated from turns in `aggregate_sessions()` (`scanner.py:452`): sums the four token counters, `turn_count`, and picks the **most-common per-turn model** (`Counter.most_common`).
- `upsert_sessions()` (`scanner.py:489`): INSERT new (skips phantom title-only rows with no `first_timestamp`), else additive UPDATE keeping the **higher-priority model** (`_model_priority`) and filling an empty topic.
- Final pass **recomputes** session totals by `SUM()` over `turns` (`scanner.py:800`) so additive drift from `INSERT OR IGNORE`-skipped duplicate turns self-corrects.

---

## 8. Project identification (`project_name_from_cwd`, `scanner.py:224`)

`cwd` (from the record) → normalize `\` to `/`, strip trailing `/`, take **last 2 path components** joined by `/` (e.g. `Github/hotel-demo`), else last component, else `"unknown"`. Project is therefore a *derived label*, not a stable id — two different machines with the same folder layout collide, which the central model must disambiguate by `system_id`.

---

## 9. Model identification

- Per-turn model = `message["model"]` (raw string, e.g. `claude-opus-4-8`).
- Session's headline model = most-common across its turns, with `_model_priority` (fable/mythos 5 > opus 3 > sonnet 2 > haiku 1) breaking ties on upsert so a subagent's haiku doesn't override the session's opus.

---

## 10. Cost calculation (`cli.py:21-67`)

- Hardcoded `PRICING` dict (per-million-token rates: input/output/cache_read/cache_write) for fable/mythos/opus/sonnet/haiku families (June-2026 rates).
- `get_pricing(model)`: exact key → `startswith` → substring-family fallback → `None`.
- `calc_cost(model, inp, out, cache_read, cache_creation)` = Σ `tokens * rate / 1e6`. Unknown model → `$0`.
- The dashboard has its own JS `calcCost()` mirroring this client-side.
- **Cost is an estimate** and unrelated to actual Max/Pro subscription billing.

---

## 11. Dashboard architecture (`dashboard.py`)

- `serve(host, port, surface)` (`dashboard.py:2296`) → `ThreadingHTTPServer((host,port), DashboardHandler)`. Default `localhost:8080` (env `HOST`/`PORT`).
- **Routes** (`DashboardHandler`, `dashboard.py:2218-2293`):
  - `GET /` or `/index.html` → `HTML_TEMPLATE` with `__APP_CONFIG_JSON__` replaced by `{version, surface}`.
  - `GET /api/data` → `json.dumps(get_dashboard_data(DB_PATH))`.
  - `GET /icon.svg` → static icon.
  - `POST /api/rescan` → `scanner.scan(...)` incremental, returns the scan-result dict.
  - anything else → 404.
- `get_dashboard_data()` (`dashboard.py:27`) runs all aggregation SQL against `turns`/`sessions`/`agents` and returns one JSON payload: `all_models`, `daily_by_model`, `hourly_by_model`, `sessions_all`, `subagent_by_type`, `top_dispatches`, etc.
- **All filtering/ranking is client-side JS** over that single payload (date range, model checkboxes, pagination, CSV export). No per-filter server round-trip.

---

## 12. CLI architecture (`cli.py`)

- Manual dispatch: `COMMANDS = {scan, today, week, stats, dashboard}` (`cli.py:454`); flags via `parse_named_arg` (`--projects-dir --host --port --no-browser --surface`); `--version`/`-V`/`version` short-circuit.
- `require_db()` (`cli.py:82`) opens the DB (row factory), runs `init_db` to migrate, exits with a hint if the DB is missing.
- `today` / `week` / `stats` = read-only `substr(timestamp,1,10)` date-bucketed SQL over `turns`, printed as fixed-width tables with cost columns.
- `dashboard` binds the port **first**, then scans in a background thread (cold scans can exceed the extension's ~10s readiness window), optionally opens a browser.

---

## 13. VS Code extension architecture (`vscode-extension/src`)

TypeScript, tested with vitest. Modules:
- **`extension.ts`** — activation, wires the sidebar + server manager.
- **`server-manager.ts`** — `ServerManager` state machine (stopped→starting→ready/failed/exited). Spawns the Python dashboard subprocess, **HTTP-probes** `/api/data` (~200ms interval, ~10s timeout) accepting a 200 JSON body containing `all_models` or `error`, streams stdout/stderr to an `OutputSink`, graceful `dispose()`.
- **`python-locator.ts`** — finds a usable Python interpreter.
- **`port-allocator.ts`** — picks a free port (multiple windows).
- **`install-mode.ts`** — bundled-vs-clone detection; only the three `.py` files ship in the `.vsix` (why `VERSION` lives in `scanner.py`, not only CHANGELOG).
- **`sidebar.ts`** — webview host.

---

## 14. Existing tests (`tests/`, 147 passing)

- **`test_scanner.py`** — the deepest: project-name extraction (incl. Windows paths), JSONL parsing & token extraction, zero-token/non-assistant skipping, malformed JSON, empty files, **message_id dedup** (`test_streaming_events_deduped`, `test_different_message_ids_kept`, `test_records_without_message_id_kept`, `test_mixed_with_and_without_ids`), **incremental scan** (`test_no_duplicate_turns_on_update`, `test_token_counts_accumulate_correctly`, `test_mtime_change_without_growth_skipped`), DB upserts, multi-file/empty-dir integration, topic handling + one-time backfill.
- **`test_cli.py` / `test_cli_subagent.py`** — command output, pricing/cost, subagent totals.
- **`test_dashboard.py` / `test_dashboard_subagent.py`** — `get_dashboard_data`, routes, subagent views.
- **`test_subagent.py`** — subagent detection/attribution.
- **`test_version.py`** — parity of `scanner.VERSION` ↔ CHANGELOG heading ↔ extension `package.json`.
- CI: `.github/workflows/tests.yml` (Python), `extension-ci.yml` (TS), `tag-on-merge.yml`.

---

## 15. Existing limitations (relative to a centralized 3-PC goal)

1. **Single machine only.** No concept of *which* PC; DB is local, dashboard is `localhost`.
2. **No stable global event id.** `turns.id` is a local AUTOINCREMENT — meaningless across machines. `message_id` is unique *within* a DB but not namespaced by machine.
3. **Turns without `message_id`** aren't deduped (appended as-is) — needs a synthetic deterministic id for cross-machine sync.
4. **Project name collisions** across machines (last-2-path-components is not machine-unique).
5. **No auth / RBAC / multi-user** — anyone with local access sees everything.
6. **All dashboard filtering is client-side** — fine locally, but cannot be trusted for server-side authorization.
7. **No push/network layer** — purely pull-from-disk. No offline queue, retry, or heartbeat concepts exist.
8. **Timestamps are stored as raw transcript strings** (ISO text), bucketed with `substr(...,1,10)` — no explicit UTC normalization at the storage layer.

---

## 16. Reusable components (use as-is)

| Component | Reuse |
|---|---|
| `scanner.py` parsing + incremental ingest | **Reuse unchanged.** The agent will call `scanner.scan()` exactly as today. |
| SQLite schema (`sessions`, `turns`, `processed_files`, `agents`, `schema_meta`) | **Reuse unchanged** as the local store. `turns` is the sync source of truth. |
| `turns.message_id` + unique index | **Reuse as the dedup key.** Namespaced with `system_id` → global `event_id`. |
| `tests/` (147) | **Reuse as a regression guard** — must stay green after we add the sync layer. |
| `cli.py` pricing/`calc_cost`, `project_name_from_cwd`, `_model_priority` | Reusable helpers; central backend can port the same pricing table. |
| Additive-migration + `schema_meta` pattern | Reuse as the template for any local-DB additions. |

---

## 17. Components that need modification / extension (additive only)

- **Nothing in `scanner.py`/`cli.py`/`dashboard.py` needs editing for Phase 1.** Centralization is *additive*: a new `agent/` package reads the local DB **read-only** and syncs.
- New local table (e.g. `sync_state`/`sync_queue`) added via the same idempotent-migration pattern, **without altering existing tables**.
- Synthetic `event_id` for `message_id`-less turns computed in the sync layer (e.g. `sha1(system_id|session_id|timestamp|tool_name|tokens)`), not by mutating `turns`.
- Central backend re-implements pricing/aggregation server-side (so authorization can't be bypassed) — it does **not** import the local dashboard's client JS.

---

## 18. Components that must remain untouched

- `scanner.py` core parsing/incremental logic (the correctness-critical, well-tested heart).
- `cli.py` commands `scan` / `today` / `week` / `stats` / `dashboard` and their behavior.
- `dashboard.py` local server on `localhost:8080` and its `/api/data` contract (the VS Code extension depends on it).
- The 147-test suite (kept green as the definition of "not broken").
- Claude Code's own files under `~/.claude/projects` (read-only; never written or deleted).

---

## Appendix — Windows specifics

- Transcripts on Windows live at `%USERPROFILE%\.claude\projects\` — confirmed on this machine (`C:\Users\aniru\.claude\projects\...`). `Path.home()` resolves correctly; `project_name_from_cwd` already normalizes `\`→`/` and has a `test_windows_path` case.
- DB defaults to `%USERPROFILE%\.claude\usage.db`; overridable via `CLAUDE_USAGE_DB` (used above to run an isolated scan without touching the user's real DB).
- `python` (not `python3`) is the working interpreter on this host.

**Next document:** [`CENTRALIZATION_PLAN.md`](CENTRALIZATION_PLAN.md) — the phased proposal to extend this into the 3-PC centralized platform.
