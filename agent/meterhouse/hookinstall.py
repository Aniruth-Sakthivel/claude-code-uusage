"""Register (and unregister) the agent's hooks in `~/.claude/settings.json`.

That file belongs to the user, not to us: it commonly holds their own hooks,
permissions and preferences. So this module edits rather than writes — our
entries are merged in, everything else is preserved byte-for-byte in meaning,
and a file we cannot parse is left strictly alone. Silently replacing someone's
settings with a Meterhouse-only file would be a far worse failure than not
installing at all.

Every handler we add carries a `_meterhouse` marker. That is what makes
`uninstall` exact: it removes our three entries and nothing that merely looks
similar, even if the user has their own `SessionStart` hooks alongside.

Matchers are deliberately omitted. A group with no matcher fires for every
variant of its event, which is exactly what metering wants — a session that
starts by `resume` or ends by `logout` counts the same as one that starts by
`startup`. Naming the variants would mean silently missing any Claude Code adds
later.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path

#: event name in settings.json -> the `meterhouse hook` argument
HOOK_EVENTS = {
    "SessionStart": "session-start",
    "SessionEnd": "session-end",
    "UserPromptSubmit": "keepalive",
}

MARKER = "_meterhouse"


def default_settings_path() -> Path:
    env = os.environ.get("METERHOUSE_CLAUDE_SETTINGS")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "settings.json"


def _quote(part: str) -> str:
    """Quote one argv element for the shell Claude Code runs hooks through."""
    if os.name == "nt":
        return f'"{part}"' if (" " in part or "\t" in part) else part
    return shlex.quote(part)


def agent_command_prefix() -> str:
    """How to invoke this agent, as installed on this machine.

    Resolved once at install time and baked into settings.json rather than
    looked up per hook: `meterhouse` is frequently not on the PATH that Claude
    Code hands to hook processes (a pip `--user` install, or a standalone exe
    dropped in LOCALAPPDATA), and a hook that cannot be found fails on every
    single session.
    """
    if getattr(sys, "frozen", False):
        return _quote(sys.executable)
    return f"{_quote(sys.executable)} -m meterhouse"


def _handler(event_arg: str, prefix: str) -> dict:
    handler = {
        "type": "command",
        "command": f"{prefix} hook {event_arg}",
        # Non-negotiable: without this the user waits on metering before their
        # own session starts, and before every prompt they submit.
        "async": True,
        MARKER: True,
    }
    if event_arg != "session-end":
        # Left off SessionEnd on purpose. Those hooks share a ~1.5s budget, and
        # declaring a timeout raises that ceiling for everyone else's hooks too.
        handler["timeout"] = 10
    return handler


def _is_ours(handler) -> bool:
    return isinstance(handler, dict) and bool(handler.get(MARKER))


def _strip_ours(groups) -> list:
    """Drop our handlers, and any group left empty by their removal."""
    if not isinstance(groups, list):
        return []
    kept = []
    for group in groups:
        if not isinstance(group, dict):
            kept.append(group)  # not ours to interpret — leave it untouched
            continue
        handlers = group.get("hooks")
        if not isinstance(handlers, list):
            kept.append(group)
            continue
        remaining = [h for h in handlers if not _is_ours(h)]
        if not remaining:
            continue  # the group existed only for us
        group = {**group, "hooks": remaining}
        kept.append(group)
    return kept


def read_settings(path: Path) -> tuple[dict, str | None]:
    """Load settings.json. Returns (settings, error).

    A missing file is fine — an empty dict, which we then create. A file that
    exists but does not parse is an error, never an empty dict: overwriting it
    would destroy the user's configuration.
    """
    if not path.exists():
        return {}, None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        return {}, f"could not read {path}: {exc}"
    if not raw.strip():
        return {}, None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return {}, f"{path} is not valid JSON ({exc}); refusing to overwrite it"
    if not isinstance(data, dict):
        return {}, f"{path} does not contain a JSON object; refusing to overwrite it"
    return data, None


def _write_settings(path: Path, settings: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)  # atomic, so an interrupted install cannot truncate it


def install(path: Path | None = None, prefix: str | None = None) -> tuple[bool, str]:
    """Add our hooks, replacing any previous Meterhouse entries. Idempotent."""
    path = Path(path) if path else default_settings_path()
    settings, error = read_settings(path)
    if error:
        return False, error

    prefix = prefix or agent_command_prefix()
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}

    for event, event_arg in HOOK_EVENTS.items():
        groups = _strip_ours(hooks.get(event, []))
        groups.append({"hooks": [_handler(event_arg, prefix)]})
        hooks[event] = groups

    settings["hooks"] = hooks
    try:
        _write_settings(path, settings)
    except OSError as exc:
        return False, f"could not write {path}: {exc}"
    return True, f"Hooks installed in {path} ({', '.join(HOOK_EVENTS)})."


def uninstall(path: Path | None = None) -> tuple[bool, str]:
    """Remove our hooks and leave everything else exactly as it was."""
    path = Path(path) if path else default_settings_path()
    settings, error = read_settings(path)
    if error:
        return False, error
    if not settings:
        return True, f"No hooks to remove ({path} does not exist)."

    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return True, "No Meterhouse hooks were installed."

    removed = 0
    for event in list(HOOK_EVENTS):
        before = hooks.get(event, [])
        if not isinstance(before, list):
            continue
        after = _strip_ours(before)
        removed += _count_ours(before) - _count_ours(after)
        if after:
            hooks[event] = after
        else:
            hooks.pop(event, None)

    if hooks:
        settings["hooks"] = hooks
    else:
        settings.pop("hooks", None)

    try:
        _write_settings(path, settings)
    except OSError as exc:
        return False, f"could not write {path}: {exc}"
    return True, f"Removed {removed} Meterhouse hook(s) from {path}."


def _count_ours(groups) -> int:
    total = 0
    for group in groups if isinstance(groups, list) else []:
        if isinstance(group, dict) and isinstance(group.get("hooks"), list):
            total += sum(1 for h in group["hooks"] if _is_ours(h))
    return total


def status(path: Path | None = None) -> dict:
    """What is currently registered — backs `meterhouse hooks-status`."""
    path = Path(path) if path else default_settings_path()
    settings, error = read_settings(path)
    installed = {}
    for event in HOOK_EVENTS:
        groups = settings.get("hooks", {}).get(event, []) if isinstance(settings, dict) else []
        installed[event] = _count_ours(groups) > 0
    return {"path": str(path), "error": error, "events": installed,
            "installed": all(installed.values())}
