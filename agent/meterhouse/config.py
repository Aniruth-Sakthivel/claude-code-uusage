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


def default_runtime_config_path() -> Path:
    env = os.environ.get("METERHOUSE_RUNTIME_CONFIG")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "meterhouse" / "runtime.json"


@dataclass
class AgentConfig:
    # Scanning
    scan_interval_seconds: int = 60
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

    @staticmethod
    def _env_overrides() -> dict:
        mapping = {
            "METERHOUSE_SCAN_INTERVAL": ("scan_interval_seconds", int),
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
            "METERHOUSE_LOG_LEVEL": ("log_level", str),
            "METERHOUSE_LOG_JSON": ("log_json", lambda v: v.lower() in ("1", "true", "yes")),
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
