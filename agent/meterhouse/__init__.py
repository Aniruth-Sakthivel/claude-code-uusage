"""Meterhouse local agent.

Original software (not derived from any third-party project). Scans Claude Code
JSONL transcripts on the local machine, stores a centralization-ready usage
record in local SQLite, and (later) syncs it to the central API.

The JSONL layout it reads is Claude Code's own on-disk data format, independently
observed from real transcripts (see docs/UPSTREAM_AUDIT.md for the format).
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version as _pkg_version

try:
    # Single source of truth: pyproject.toml's [project] version, so an
    # installed wheel/sdist and `__version__` can never drift apart.
    __version__ = _pkg_version("meterhouse-rotor")
except PackageNotFoundError:
    # Running from a source checkout without an editable install.
    __version__ = "0.0.0+dev"

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
        from .sync import warn_if_insecure

        self.identity.server_url = server_url.rstrip("/")
        self.identity.api_key = api_key
        warning = warn_if_insecure(self.identity.server_url)
        if warning:
            import warnings

            warnings.warn(warning, stacklevel=2)
        if display_name:
            self.identity.display_name = display_name
        save_identity(self.identity, self.config_path)

        if ws_url:
            ws_warning = warn_if_insecure(ws_url)
            if ws_warning:
                import warnings

                warnings.warn(ws_warning, stacklevel=2)
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

    def daemon(self, display_name: str | None = None, always_on: bool | None = None) -> None:
        """Run the agent until the last Claude Code session ends, then return.

        This blocks for the lifetime of the session, not forever: with no
        session open it scans once and returns immediately. Pass
        `always_on=True` for the old run-until-killed behaviour.
        """
        run_daemon(display_name=display_name, db_path=self.db_path, always_on=always_on)

    def sessions(self) -> list:
        """Claude Code sessions this machine currently believes are live."""
        from .config import AgentConfig
        from .sessions import SessionRegistry

        return SessionRegistry().active(AgentConfig.load().validated().session_idle_timeout_seconds)

    def install_hooks(self) -> tuple[bool, str]:
        """Wire Claude Code's session hooks so the agent runs on demand."""
        from .hookinstall import install

        return install()

    def uninstall_hooks(self) -> tuple[bool, str]:
        from .hookinstall import uninstall

        return uninstall()
