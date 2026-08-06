"""Health/diagnostics state for the daemon.

The daemon (a long-running process) writes its status to a small JSON file on
every cycle; the short-lived `meterhouse health` CLI command just reads it.
That split means health can be inspected without reaching into the daemon's
process (no IPC/RPC needed) and survives the daemon being unreachable — a
stale timestamp *is* the diagnostic in that case.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


def default_health_path() -> Path:
    env = os.environ.get("METERHOUSE_HEALTH_FILE")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "meterhouse" / "health.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class HealthState:
    started_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    last_scan_at: str | None = None
    last_scan_duration_ms: float | None = None
    last_scan_error: str | None = None
    scans_completed: int = 0
    scans_failed: int = 0
    ws_connected: bool = False
    ws_last_connected_at: str | None = None
    ws_last_disconnect_reason: str | None = None
    ws_reconnect_attempts: int = 0
    offline_queue_depth: int = 0
    #: Claude Code sessions live when the daemon last looked. The daemon exists
    #: only while this is non-zero, so it doubles as the reason it is running.
    active_sessions: int = 0
    #: Set when the daemon exited cleanly. A file with `stopped_at` set is a
    #: healthy agent that finished, not a dead one — the distinction the whole
    #: event-driven model depends on, since silence is now the normal state.
    stopped_at: str | None = None
    pid: int = field(default_factory=os.getpid)

    def touch(self) -> None:
        """Mark the process as alive without changing any counter.

        The daemon calls this on a short fixed timer so `updated_at` reflects
        liveness rather than scan cadence — see daemon.HEALTH_HEARTBEAT_SECONDS.
        """
        self.updated_at = _now()

    def record_stopped(self) -> None:
        """Mark a clean exit, so a later reader can tell finished from died."""
        self.stopped_at = _now()
        self.active_sessions = 0
        self.updated_at = _now()

    def record_scan(self, duration_ms: float, error: str | None = None) -> None:
        self.last_scan_at = _now()
        self.last_scan_duration_ms = duration_ms
        self.last_scan_error = error
        if error:
            self.scans_failed += 1
        else:
            self.scans_completed += 1
        self.updated_at = _now()

    def record_ws_connected(self) -> None:
        self.ws_connected = True
        self.ws_last_connected_at = _now()
        self.ws_reconnect_attempts = 0
        self.updated_at = _now()

    def record_ws_disconnected(self, reason: str) -> None:
        self.ws_connected = False
        self.ws_last_disconnect_reason = reason
        self.updated_at = _now()

    def record_ws_reconnect_attempt(self) -> None:
        self.ws_reconnect_attempts += 1
        self.updated_at = _now()

    def save(self, path: Path | None = None) -> None:
        path = Path(path) if path else default_health_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        tmp.replace(path)  # atomic on both POSIX and Windows

    @classmethod
    def load(cls, path: Path | None = None) -> "HealthState | None":
        path = Path(path) if path else default_health_path()
        if not path.exists():
            return None
        try:
            return cls(**json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, TypeError):
            return None
