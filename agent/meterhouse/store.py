"""Local SQLite store for usage events.

Design differences from a naive port (this is our own schema, built for the
fleet from the start):

* ``usage_events`` is the single source of truth. Session/day/model rollups are
  computed with SQL, so there is no dual-write drift to reconcile.
* ``event_id`` is the primary key and is machine-namespaced, so ``INSERT OR
  IGNORE`` makes re-scanning and re-syncing idempotent — a record can never be
  counted twice.
* A per-event ``synced`` flag is the sync watermark for central mode.
* Timestamps are stored UTC; ``day`` is precomputed for fast grouping.

Schema changes go through :meth:`init_schema` (idempotent) + additive migrations
keyed on ``meta.schema_version``.
"""

from __future__ import annotations

import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2

# How long a writer waits on "database is locked" before giving up, on top of
# sqlite3's own busy timeout below — covers the case where the daemon's
# scheduled scan and a manual `meterhouse scan` CLI invocation race each other.
_COMMIT_RETRY_ATTEMPTS = 5
_COMMIT_RETRY_BASE_SECONDS = 0.2


def default_db_path() -> Path:
    env = os.environ.get("METERHOUSE_DB")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "meterhouse" / "usage.db"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, db_path: Path | str | None = None):
        self.db_path = Path(db_path) if db_path else default_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # timeout=30: how long sqlite3 itself blocks on a lock before raising
        # OperationalError, so a concurrent writer (daemon vs. CLI) usually
        # never needs the retry loop in `commit()` below at all.
        self.conn = sqlite3.connect(self.db_path, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.init_schema()

    # ── schema ──────────────────────────────────────────────────────────────
    def init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS scanned_files (
                path       TEXT PRIMARY KEY,
                mtime      REAL,
                line_count INTEGER,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                event_id              TEXT PRIMARY KEY,
                system_id             TEXT NOT NULL,
                session_id            TEXT,
                project_name          TEXT,
                ts_utc                TEXT,
                day                   TEXT,
                model                 TEXT,
                model_family          TEXT,
                input_tokens          INTEGER DEFAULT 0,
                output_tokens         INTEGER DEFAULT 0,
                cache_read_tokens     INTEGER DEFAULT 0,
                cache_creation_tokens INTEGER DEFAULT 0,
                total_tokens          INTEGER DEFAULT 0,
                tool_name             TEXT,
                is_subagent           INTEGER DEFAULT 0,
                agent_id              TEXT,
                source_file           TEXT,
                synced                INTEGER DEFAULT 0,
                created_at            TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_events_day     ON usage_events(day);
            CREATE INDEX IF NOT EXISTS idx_events_session ON usage_events(session_id);
            CREATE INDEX IF NOT EXISTS idx_events_model   ON usage_events(model_family);
            CREATE INDEX IF NOT EXISTS idx_events_synced  ON usage_events(synced);

            -- Human prompts (schema v2). One row per typed turn, keyed by the
            -- transcript record's own uuid so a re-scan cannot double-count.
            -- Deliberately not in usage_events: a prompt has no tokens, and
            -- mixing it in would inflate event and session counts everywhere.
            CREATE TABLE IF NOT EXISTS prompt_events (
                prompt_id  TEXT PRIMARY KEY,
                session_id TEXT,
                day        TEXT,
                synced     INTEGER DEFAULT 0,
                created_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_prompts_day    ON prompt_events(day);
            CREATE INDEX IF NOT EXISTS idx_prompts_synced ON prompt_events(synced);

            -- Session titles (schema v2). Held locally always; transmitted
            -- only when session_titles_enabled is switched on, because a title
            -- can describe what someone was working on.
            CREATE TABLE IF NOT EXISTS session_titles (
                session_id TEXT PRIMARY KEY,
                title      TEXT,
                updated_at TEXT,
                synced     INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_titles_synced ON session_titles(synced);
            """
        )
        # New tables are additive, so CREATE TABLE IF NOT EXISTS above is the
        # entire migration — just record the version we are now at.
        cur = self.get_meta("schema_version")
        if cur is None or int(cur) < SCHEMA_VERSION:
            self.set_meta("schema_version", str(SCHEMA_VERSION))
        self.commit()

    # ── meta ────────────────────────────────────────────────────────────────
    def get_meta(self, key: str):
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
        self.commit()

    # ── file watermark ────────────────────────────────────────────────────────
    def get_scanned_file(self, path: str):
        return self.conn.execute(
            "SELECT mtime, line_count FROM scanned_files WHERE path = ?",
            (path,)).fetchone()

    def set_scanned_file(self, path: str, mtime: float, line_count: int) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO scanned_files (path, mtime, line_count, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (path, mtime, line_count, _utc_now_iso()))

    # ── events ────────────────────────────────────────────────────────────────
    def insert_events(self, events: list[dict]) -> int:
        """Insert events, ignoring any whose event_id already exists.

        Returns the number of rows actually inserted (duplicates ignored). This
        is the guarantee against double-counting across re-scans.
        """
        if not events:
            return 0
        before = self.conn.total_changes
        now = _utc_now_iso()
        self.conn.executemany(
            """
            INSERT OR IGNORE INTO usage_events (
                event_id, system_id, session_id, project_name, ts_utc, day,
                model, model_family, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, total_tokens,
                tool_name, is_subagent, agent_id, source_file, synced, created_at
            ) VALUES (
                :event_id, :system_id, :session_id, :project_name, :ts_utc, :day,
                :model, :model_family, :input_tokens, :output_tokens,
                :cache_read_tokens, :cache_creation_tokens, :total_tokens,
                :tool_name, :is_subagent, :agent_id, :source_file, 0, :created_at
            )
            """,
            [{**e, "created_at": now} for e in events],
        )
        return self.conn.total_changes - before

    # ── prompts ───────────────────────────────────────────────────────────────
    def insert_prompts(self, prompts: list[tuple[str, str, str]]) -> int:
        """Record human prompts as ``(prompt_id, session_id, day)`` triples.

        Same idempotency trick as events: the transcript record's uuid is the
        primary key, so re-scanning a grown file never double-counts.
        """
        if not prompts:
            return 0
        before = self.conn.total_changes
        now = _utc_now_iso()
        self.conn.executemany(
            "INSERT OR IGNORE INTO prompt_events (prompt_id, session_id, day, synced, created_at) "
            "VALUES (?, ?, ?, 0, ?)",
            [(pid, sid, day, now) for pid, sid, day in prompts],
        )
        return self.conn.total_changes - before

    def unsynced_prompt_counts(self, limit: int = 500) -> list[sqlite3.Row]:
        """Cumulative per-(session, day) counts for any day with new prompts.

        Cumulative rather than incremental so the server can upsert with a
        MAX(), which makes retries and out-of-order batches harmless.
        """
        return self.conn.execute(
            """
            SELECT session_id, day, COUNT(*) AS prompt_count
            FROM prompt_events
            WHERE (session_id, day) IN (
                SELECT session_id, day FROM prompt_events WHERE synced = 0
            )
            GROUP BY session_id, day
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    def mark_prompts_synced(self, pairs: list[tuple[str, str]]) -> None:
        if not pairs:
            return
        self.conn.executemany(
            "UPDATE prompt_events SET synced = 1 WHERE session_id = ? AND day = ?", pairs
        )
        self.commit()

    def prompt_total(self) -> int:
        row = self.conn.execute("SELECT COUNT(*) AS n FROM prompt_events").fetchone()
        return int(row["n"]) if row else 0

    # ── session titles ────────────────────────────────────────────────────────
    def upsert_session_titles(self, titles: dict[str, str]) -> None:
        """Store titles locally regardless of whether they will be sent.

        A changed title resets `synced` so the update propagates.
        """
        if not titles:
            return
        now = _utc_now_iso()
        self.conn.executemany(
            """
            INSERT INTO session_titles (session_id, title, updated_at, synced)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(session_id) DO UPDATE SET
                title = excluded.title,
                updated_at = excluded.updated_at,
                synced = CASE WHEN session_titles.title IS excluded.title THEN session_titles.synced ELSE 0 END
            """,
            [(sid, title, now) for sid, title in titles.items() if title],
        )

    def unsynced_titles(self, limit: int = 500) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT session_id, title FROM session_titles WHERE synced = 0 LIMIT ?", (limit,)
        ).fetchall()

    def mark_titles_synced(self, session_ids: list[str]) -> None:
        if not session_ids:
            return
        self.conn.executemany(
            "UPDATE session_titles SET synced = 1 WHERE session_id = ?",
            [(sid,) for sid in session_ids],
        )
        self.commit()

    def commit(self) -> None:
        """Commit with a short retry against a transient ``database is locked``.

        The daemon's scheduled scan and a manually-run `meterhouse scan`/`sync`
        can legitimately overlap for a moment; sqlite3's own busy timeout
        (see ``timeout=30`` in ``__init__``) handles most of that, but a
        commit can still lose the race right at the timeout boundary. Retry a
        handful of times with a short backoff before giving up for real.
        """
        for attempt in range(1, _COMMIT_RETRY_ATTEMPTS + 1):
            try:
                self.conn.commit()
                return
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == _COMMIT_RETRY_ATTEMPTS:
                    raise
                time.sleep(_COMMIT_RETRY_BASE_SECONDS * attempt)

    def close(self) -> None:
        self.conn.close()

    # ── sync helpers (used in central mode) ──────────────────────────────────
    def unsynced_events(self, limit: int = 500) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM usage_events WHERE synced = 0 ORDER BY ts_utc LIMIT ?",
            (limit,)).fetchall()

    def mark_synced(self, event_ids: list[str]) -> None:
        if not event_ids:
            return
        self.conn.executemany(
            "UPDATE usage_events SET synced = 1 WHERE event_id = ?",
            [(eid,) for eid in event_ids])
        self.commit()
