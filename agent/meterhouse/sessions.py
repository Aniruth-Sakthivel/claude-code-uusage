"""Which Claude Code sessions are live on this machine, right now.

This is the registry the whole event-driven lifecycle turns on: Claude Code's
hooks write to it (see :mod:`meterhouse.hooks`) and the daemon reads it to
decide whether it still has a reason to exist. No active session, no agent.

**One small JSON file per session**, not a table in the usage DB. Hooks fire on
a hot path — `SessionEnd` handlers share a 1.5 second budget across all of
them — and several Claude Code windows can be open at once, so anything with a
writer lock would put session bookkeeping behind the scanner's long-running
writes. A file per session is lock-free by construction: concurrent sessions
touch disjoint paths and can never block each other.

Liveness is deliberately *not* just "did SessionEnd fire". Claude Code that is
killed, crashes, or loses power never fires it, and a registry that trusted
that alone would pin a daemon open forever. A session is live while either its
record or its transcript has been touched recently — the transcript half is
what keeps a long agent turn (many minutes, no prompt submitted) from being
mistaken for an abandoned window.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

#: Session ids come from hook JSON — i.e. from outside this process — and are
#: used to build a filename. Anything that is not a plain id is refused rather
#: than sanitized into a *different* valid id, so two distinct sessions can
#: never collapse onto one record.
_SAFE_SESSION_ID = re.compile(r"\A[A-Za-z0-9._-]{1,128}\Z")


def default_sessions_dir() -> Path:
    env = os.environ.get("METERHOUSE_SESSIONS_DIR")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "meterhouse" / "sessions"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    # A record written by an older build (or hand-edited) may be naive; treat
    # it as UTC rather than raising on the comparison in `age_seconds`.
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


@dataclass
class SessionRecord:
    session_id: str
    cwd: str = ""
    transcript_path: str = ""
    source: str = ""
    started_at: str = field(default_factory=_now)
    last_activity_at: str = field(default_factory=_now)

    def age_seconds(self, now: datetime | None = None) -> float:
        """Seconds since this session last showed any sign of life.

        The later of the recorded activity and the transcript's mtime. The
        transcript is what covers a long turn: Claude Code can work for many
        minutes without the user submitting anything, and only the transcript
        grows during it.
        """
        now = now or datetime.now(timezone.utc)
        latest = _parse_ts(self.last_activity_at) or _parse_ts(self.started_at)

        if self.transcript_path:
            try:
                mtime = datetime.fromtimestamp(
                    os.stat(self.transcript_path).st_mtime, tz=timezone.utc
                )
                if latest is None or mtime > latest:
                    latest = mtime
            except OSError:
                pass  # not written yet, or gone — fall back to the record

        if latest is None:
            return float("inf")  # unparseable timestamps: treat as stale
        return max(0.0, (now - latest).total_seconds())


class SessionRegistry:
    """The set of live Claude Code sessions for the current OS user.

    Everything lives under the user's home, so on a shared machine each user
    gets an independent registry, daemon and lock with no extra work.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self.dir = Path(directory) if directory else default_sessions_dir()

    def _path_for(self, session_id: str) -> Path | None:
        if not isinstance(session_id, str) or not _SAFE_SESSION_ID.match(session_id):
            return None
        return self.dir / f"{session_id}.json"

    def open_session(
        self,
        session_id: str,
        cwd: str = "",
        transcript_path: str = "",
        source: str = "",
    ) -> SessionRecord | None:
        """Record a session as live. Idempotent.

        `SessionStart` fires again for the same id on `clear`, `compact` and
        `resume`, so re-opening must refresh the record rather than reset the
        session's history — `started_at` is preserved.
        """
        path = self._path_for(session_id)
        if path is None:
            return None

        existing = self._read(path)
        record = SessionRecord(
            session_id=session_id,
            cwd=cwd or (existing.cwd if existing else ""),
            transcript_path=transcript_path or (existing.transcript_path if existing else ""),
            source=source or (existing.source if existing else ""),
            started_at=existing.started_at if existing else _now(),
            last_activity_at=_now(),
        )
        self._write(path, record)
        return record

    def touch(self, session_id: str, transcript_path: str = "") -> SessionRecord | None:
        """Refresh a session's liveness.

        Creates the record if it is missing rather than dropping the event:
        hooks installed midway through a session deliver `UserPromptSubmit`
        for a session whose `SessionStart` we never saw, and that session is
        just as live as any other.
        """
        path = self._path_for(session_id)
        if path is None:
            return None

        existing = self._read(path)
        if existing is None:
            return self.open_session(session_id, transcript_path=transcript_path)

        existing.last_activity_at = _now()
        if transcript_path:
            existing.transcript_path = transcript_path
        self._write(path, existing)
        return existing

    def close_session(self, session_id: str) -> bool:
        """Drop a session. True if a record was actually removed."""
        path = self._path_for(session_id)
        if path is None:
            return False
        try:
            path.unlink()
            return True
        except OSError:
            return False  # already gone, or racing another hook — either is fine

    def all_records(self) -> list[SessionRecord]:
        try:
            entries = sorted(self.dir.glob("*.json"))
        except OSError:
            return []
        out = []
        for entry in entries:
            record = self._read(entry)
            if record is not None:
                out.append(record)
        return out

    def active(self, idle_timeout_seconds: float) -> list[SessionRecord]:
        """Sessions that are still live, newest activity first."""
        now = datetime.now(timezone.utc)
        live = [r for r in self.all_records() if r.age_seconds(now) <= idle_timeout_seconds]
        live.sort(key=lambda r: r.age_seconds(now))
        return live

    def reap_stale(self, idle_timeout_seconds: float) -> int:
        """Delete records for sessions that went quiet without a `SessionEnd`.

        Called by the daemon as it shuts down, so a machine that is killed
        mid-session does not leave a record behind that makes the next
        `ensure_daemon_running` think work is in progress.
        """
        now = datetime.now(timezone.utc)
        removed = 0
        for record in self.all_records():
            if record.age_seconds(now) > idle_timeout_seconds:
                if self.close_session(record.session_id):
                    removed += 1
        return removed

    # -- storage -------------------------------------------------------------

    def _read(self, path: Path) -> SessionRecord | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        if not isinstance(data, dict):
            return None
        known = {f for f in SessionRecord.__dataclass_fields__}
        data = {k: v for k, v in data.items() if k in known}
        if not data.get("session_id"):
            return None
        try:
            return SessionRecord(**data)
        except TypeError:
            return None

    def _write(self, path: Path, record: SessionRecord) -> None:
        """Atomic, and never fatal.

        The temp file is per-record, so two hooks writing different sessions
        at the same moment cannot clobber each other's staging file.
        """
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(asdict(record), indent=2), encoding="utf-8")
            tmp.replace(path)  # atomic on POSIX and Windows
        except OSError:
            pass  # a registry write must never take down a hook or the daemon
