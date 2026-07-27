"""ClaudeFleet local agent.

Original software (not derived from any third-party project). Scans Claude Code
JSONL transcripts on the local machine, stores a centralization-ready usage
record in local SQLite, and (later) syncs it to the central API.

The JSONL layout it reads is Claude Code's own on-disk data format, independently
observed from real transcripts (see docs/UPSTREAM_AUDIT.md for the format).
"""

from __future__ import annotations

from .cli import build_parser, main as cli_main
from .config import AgentConfig
from .daemon import run_daemon
from .health import HealthState
from .identity import (
    Identity,
    default_config_path,
    load_identity,
    save_identity,
)
from .scanner import discover_files, scan as scan_files
from .store import Store, default_db_path
from .sync import SyncClient, sync_store

__version__ = "0.1.0"

__all__ = [
    "Agent",
    "cli_main",
    "build_parser",
    "AgentConfig",
    "HealthState",
    "Identity",
    "load_identity",
    "save_identity",
    "default_config_path",
    "discover_files",
    "scan_files",
    "Store",
    "default_db_path",
    "SyncClient",
    "sync_store",
    "run_daemon",
    "__version__",
]


class Agent:
    def __init__(
        self,
        config_path: str | None = None,
        db_path: str | None = None,
        display_name: str | None = None,
    ) -> None:
        self.config_path = config_path
        self.db_path = db_path or str(default_db_path())
        self.identity = load_identity(config_path=config_path, display_name=display_name)
        self.config = AgentConfig.load()

    def register(
        self,
        server_url: str,
        api_key: str,
        display_name: str | None = None,
        ws_url: str | None = None,
    ) -> dict:
        self.identity.server_url = server_url.rstrip("/")
        self.identity.api_key = api_key
        if display_name:
            self.identity.display_name = display_name
        save_identity(self.identity, self.config_path)

        if ws_url:
            self.config.ws_enabled = True
            self.config.ws_url = ws_url
            self.config.save()

        client = SyncClient(self.identity.server_url, self.identity.api_key)
        return client.register(
            self.identity.display_name,
            self.identity.hostname,
            self.identity.agent_version,
        )

    def scan(self, verbose: bool = False, project_dirs: list[str] | None = None) -> dict:
        return scan_files(
            system_id=self.identity.system_id,
            db_path=self.db_path,
            project_dirs=project_dirs,
            verbose=verbose,
        )

    def sync(self, verbose: bool = False) -> dict:
        if not self.identity.server_url or not self.identity.api_key:
            raise RuntimeError(
                "Central mode not configured. Call register() with server_url and api_key first."
            )
        store = Store(self.db_path)
        try:
            client = SyncClient(self.identity.server_url, self.identity.api_key)
            return sync_store(store, client, verbose=verbose)
        finally:
            store.close()

    def health(self) -> HealthState | None:
        return HealthState.load()

    def daemon(self, display_name: str | None = None) -> None:
        run_daemon(display_name=display_name, db_path=self.db_path)
