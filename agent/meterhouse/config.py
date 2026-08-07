"""Runtime configuration for the agent's real-time daemon.

Separate from :mod:`identity` (which holds machine identity + credentials and
is untouched by this module) because these are operational knobs an operator
tunes per-deployment: scan cadence, WebSocket endpoint, retry/backoff limits,
timeouts, and log level. Three layers, later wins:

    built-in defaults  <  runtime.json (persisted)  <  METERHOUSE_* env vars

Env vars are for one-off overrides (e.g. a systemd unit or container) without
editing the file; the file is for anything meant to persist across runs.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, fields
from pathlib import Path


#: Fields the dashboard is allowed to change remotely, via a `set_config`
#: command. An allowlist rather than "any attribute that exists": the config
#: also holds things a remote operator has no business setting on someone's
#: machine (`log_file`, the account/title privacy switches), and `hasattr`
#: would happily accept every one of them.
CONFIG_PATCH_ALLOWLIST = frozenset({
    "scan_interval_seconds",
    "sync_interval_seconds",
    "session_idle_timeout_seconds",
    "ws_enabled",
    "session_titles_enabled",
    "account_reporting_enabled",
})


def default_runtime_config_path() -> Path:
    env = os.environ.get("METERHOUSE_RUNTIME_CONFIG")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "meterhouse" / "runtime.json"


@dataclass
class AgentConfig:
    # Scanning. The daemon is always-on now (no Claude Code session hooks) —
    # every tick re-scans the transcript tree, which is cheap and incremental
    # (mtime-watermarked), so this can be tight.
    scan_interval_seconds: int = 5
    # A full sync round trip (usage push + heartbeat + account report) is not
    # free at fleet scale, so it runs on its own, slower cadence — except a
    # tick that actually found new events always syncs immediately regardless
    # of this interval, so real activity is never delayed by it. Never faster
    # than scan_interval_seconds (see `validated()`); syncing more often than
    # you scan has nothing new to say.
    sync_interval_seconds: int = 20
    # How stale a transcript can be and still count toward the "active
    # sessions" number reported to the dashboard (`activity.count_recent`) —
    # a file-level proxy now that there is no hook-fed session registry.
    session_idle_timeout_seconds: int = 300
    # Real-time push (optional — the agent works fully without it, falling
    # back to the existing REST `sync` path on its own schedule).
    ws_enabled: bool = False
    ws_url: str | None = None
    ws_connect_timeout_seconds: float = 10.0
    ws_heartbeat_interval_seconds: float = 20.0
    ws_heartbeat_timeout_seconds: float = 45.0
    # Retry / backoff (applies to both WS reconnects and REST sync retries)
    retry_max_attempts: int = 8
    retry_backoff_base_seconds: float = 1.0
    retry_backoff_max_seconds: float = 60.0
    # Networking
    http_timeout_seconds: float = 15.0
    # Outbound queue cap while disconnected — bounded so a long outage can't
    # grow memory without limit; oldest events are dropped first (the next
    # full `scan` still catches anything lost, since scan state is durable).
    offline_queue_max_items: int = 5000
    # Claude account reporting — OFF by default, and deliberately so.
    # Turning this on widens what leaves the machine beyond token counts to
    # include the Claude account's identity (email, org, plan tier) and the
    # rate-limit utilization Claude Code caches. Credentials are never read.
    # See meterhouse/account.py, and `meterhouse account show` to inspect the
    # exact payload before enabling.
    account_reporting_enabled: bool = False
    # Session titles - also OFF by default and for the same reason. A title
    # like "Migrate billing schema" describes what someone was working on,
    # which is a step beyond the token counts the agent otherwise sends.
    # Prompt *counts* need no flag: a number carries no content.
    session_titles_enabled: bool = False
    # Observability
    log_level: str = "INFO"
    log_json: bool = True
    # Where the daemon's log goes. It runs detached and windowless, so stderr
    # goes nowhere — without a file there is no record at all of what a
    # background agent did. None means the default path below.
    log_file: str | None = None
    log_file_max_bytes: int = 1_000_000
    log_file_backups: int = 2

    @staticmethod
    def _env_overrides() -> dict:
        mapping = {
            "METERHOUSE_SCAN_INTERVAL": ("scan_interval_seconds", int),
            "METERHOUSE_SYNC_INTERVAL": ("sync_interval_seconds", int),
            "METERHOUSE_WS_ENABLED": ("ws_enabled", lambda v: v.lower() in ("1", "true", "yes")),
            "METERHOUSE_WS_URL": ("ws_url", str),
            "METERHOUSE_WS_CONNECT_TIMEOUT": ("ws_connect_timeout_seconds", float),
            "METERHOUSE_WS_HEARTBEAT_INTERVAL": ("ws_heartbeat_interval_seconds", float),
            "METERHOUSE_WS_HEARTBEAT_TIMEOUT": ("ws_heartbeat_timeout_seconds", float),
            "METERHOUSE_RETRY_MAX_ATTEMPTS": ("retry_max_attempts", int),
            "METERHOUSE_RETRY_BACKOFF_BASE": ("retry_backoff_base_seconds", float),
            "METERHOUSE_RETRY_BACKOFF_MAX": ("retry_backoff_max_seconds", float),
            "METERHOUSE_HTTP_TIMEOUT": ("http_timeout_seconds", float),
            "METERHOUSE_OFFLINE_QUEUE_MAX": ("offline_queue_max_items", int),
            "METERHOUSE_ACCOUNT_REPORTING": (
                "account_reporting_enabled",
                lambda v: v.lower() in ("1", "true", "yes"),
            ),
            "METERHOUSE_SESSION_TITLES": (
                "session_titles_enabled",
                lambda v: v.lower() in ("1", "true", "yes"),
            ),
            "METERHOUSE_SESSION_IDLE_TIMEOUT": ("session_idle_timeout_seconds", int),
            "METERHOUSE_LOG_LEVEL": ("log_level", str),
            "METERHOUSE_LOG_JSON": ("log_json", lambda v: v.lower() in ("1", "true", "yes")),
            "METERHOUSE_LOG_FILE": ("log_file", str),
        }
        out = {}
        for env_name, (field_name, caster) in mapping.items():
            raw = os.environ.get(env_name)
            if raw is None or raw == "":
                continue
            try:
                out[field_name] = caster(raw)
            except (ValueError, TypeError):
                continue  # malformed override — ignore rather than crash the agent
        return out

    @classmethod
    def load(cls, path: Path | None = None) -> "AgentConfig":
        path = Path(path) if path else default_runtime_config_path()
        data: dict = {}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                data = {}  # corrupt file — fall back to defaults rather than crash

        known = {f.name for f in fields(cls)}
        data = {k: v for k, v in data.items() if k in known}
        cfg = cls(**data)

        for field_name, value in cls._env_overrides().items():
            setattr(cfg, field_name, value)
        return cfg

    def save(self, path: Path | None = None) -> None:
        path = Path(path) if path else default_runtime_config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")

    def validated(self) -> "AgentConfig":
        """Clamp obviously-unsafe values instead of failing at runtime.

        Bounds are deliberately generous — this guards against typos and
        hostile config files, not against legitimate tuning.
        """
        self.scan_interval_seconds = max(5, min(self.scan_interval_seconds, 86_400))
        # Never faster than the scan cadence — a sync tighter than the scan
        # interval would have nothing new to report most of the time.
        self.sync_interval_seconds = max(
            self.scan_interval_seconds, min(self.sync_interval_seconds, 3_600)
        )
        self.session_idle_timeout_seconds = max(30, min(self.session_idle_timeout_seconds, 86_400))
        self.log_file_max_bytes = max(10_000, min(self.log_file_max_bytes, 100_000_000))
        self.log_file_backups = max(0, min(self.log_file_backups, 20))
        self.retry_max_attempts = max(1, min(self.retry_max_attempts, 50))
        self.retry_backoff_base_seconds = max(0.1, min(self.retry_backoff_base_seconds, 300))
        self.retry_backoff_max_seconds = max(
            self.retry_backoff_base_seconds, min(self.retry_backoff_max_seconds, 3600)
        )
        self.http_timeout_seconds = max(1.0, min(self.http_timeout_seconds, 300))
        self.offline_queue_max_items = max(10, min(self.offline_queue_max_items, 100_000))
        if self.log_level.upper() not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
            self.log_level = "INFO"
        return self

    def resolved_log_file(self) -> Path:
        """The daemon's log path, defaulted alongside the rest of its state."""
        if self.log_file:
            return Path(self.log_file)
        return Path.home() / ".claude" / "meterhouse" / "agent.log"

    def apply_patch(self, payload: dict) -> list[str]:
        """Apply an allowlisted `set_config` push and persist. Returns the
        field names actually applied.

        Shared by both paths that can receive one — the daemon's command
        handler and the one-shot CLI's. They used to implement this
        separately, and the CLI's copy accepted any existing attribute and
        skipped validation, so the same dashboard action had different reach
        and different bounds depending on which one happened to pick it up.
        """
        applied = []
        for key, value in (payload or {}).items():
            if key not in CONFIG_PATCH_ALLOWLIST:
                continue
            setattr(self, key, value)
            applied.append(key)
        if applied:
            self.validated()
            self.save()
        return applied
