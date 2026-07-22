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
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1


def default_db_path() -> Path:
    env = os.environ.get("CLAUDEFLEET_DB")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "claudefleet" / "usage.db"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, db_path: Path | str | None = None):
        self.db_path = Path(db_path) if db_path else default_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path)
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
            """
        )
        cur = self.get_meta("schema_version")
        if cur is None:
            self.set_meta("schema_version", str(SCHEMA_VERSION))
        self.conn.commit()

    # ── meta ────────────────────────────────────────────────────────────────
    def get_meta(self, key: str):
        row = self.conn.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
        self.conn.commit()

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

    def commit(self) -> None:
        self.conn.commit()

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
        self.conn.commit()
