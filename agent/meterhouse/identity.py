"""Local machine identity + agent configuration.

Each PC gets a persistent, immutable ``system_id`` (a UUID) so the central
platform can attribute usage to the right machine without relying on hostname
(which can change or collide). Stored as JSON on disk and generated once on
first run.
"""

from __future__ import annotations

import json
import os
import socket
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path

from . import __version__


def default_config_path() -> Path:
    """Where the agent config lives (override with ``METERHOUSE_CONFIG``)."""
    env = os.environ.get("METERHOUSE_CONFIG")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "meterhouse" / "agent.json"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Identity:
    system_id: str            # immutable UUID for this machine
    installation_id: str      # rotates on reinstall
    hostname: str             # informational
    display_name: str         # human label, e.g. "PC-01"
    agent_version: str
    created_at: str
    # Central-mode config (unused in local mode; filled by `register`)
    server_url: str | None = None
    api_key: str | None = None

    def public_dict(self) -> dict:
        """Serializable view with the secret api_key redacted."""
        d = asdict(self)
        if d.get("api_key"):
            d["api_key"] = "***"
        return d


def load_identity(config_path: Path | None = None,
                  display_name: str | None = None) -> Identity:
    """Load the agent identity, creating it on first run.

    ``display_name`` only applies when the config is first created; an existing
    config's display name is preserved (change it via :func:`save_identity`).
    """
    path = Path(config_path) if config_path else default_config_path()

    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        # Keep the reported agent_version current even for older config files.
        data["agent_version"] = __version__
        return Identity(**data)

    ident = Identity(
        system_id=str(uuid.uuid4()),
        installation_id=str(uuid.uuid4()),
        hostname=socket.gethostname(),
        display_name=display_name or socket.gethostname(),
        agent_version=__version__,
        created_at=_utc_now_iso(),
    )
    save_identity(ident, path)
    return ident


def save_identity(ident: Identity, config_path: Path | None = None) -> None:
    path = Path(config_path) if config_path else default_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(ident), indent=2), encoding="utf-8")
