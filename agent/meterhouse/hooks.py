"""Claude Code hook handlers — the agent's event source.

Claude Code already knows exactly when someone starts working; the agent used
to rediscover it by polling the filesystem around the clock. These handlers are
wired into `~/.claude/settings.json` (see :mod:`meterhouse.hookinstall`) so the
daemon starts on `SessionStart`, stops after the last `SessionEnd`, and comes
back on the next prompt if it died in between.

Three rules govern everything here, all forced by the hook contract:

1. **Always exit 0, always silently.** For `SessionStart` (and
   `UserPromptSubmit`) Claude Code injects the hook's stdout into the model's
   context, and treats exit code 2 as a blocking error. A chatty or failing
   metering hook would corrupt every session on the machine. So nothing is
   printed to stdout, ever, and every failure path still returns 0.

2. **Be quick.** All `SessionEnd` hooks on the machine share a ~1.5 second
   budget. These handlers only touch small files and possibly spawn a detached
   process; the expensive part (the final scan and sync) is the *daemon's* job
   as it shuts down, not the hook's.

3. **Never hold Claude Code open.** The spawned daemon gets DEVNULL for all
   three standard streams and a detached process group. Inheriting the hook's
   pipes would leave Claude Code waiting on a handle held by a process designed
   to outlive it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from .config import AgentConfig
from .lockfile import SingleInstanceLock
from .logging_setup import configure_logging, get_logger
from .sessions import SessionRegistry

log = get_logger("meterhouse.hooks")

#: Hook events this module handles, mapped to the CLI's `hook` argument.
EVENTS = ("session-start", "session-end", "keepalive")


def read_hook_input(stream=None) -> dict:
    """Parse the hook payload from stdin, tolerantly.

    Anything unreadable becomes an empty dict rather than an exception: a hook
    that crashes on unexpected input is a hook that breaks the user's session.
    """
    stream = stream if stream is not None else sys.stdin
    if stream is None:
        # Windowless interpreters (pythonw) hand back a null stdin when the
        # host did not attach one. Nothing to read is not an error.
        return {}
    try:
        raw = stream.read()
    except (OSError, ValueError):
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _daemon_command() -> list[str] | None:
    """How to relaunch this agent as a daemon, for the way it was installed.

    Frozen builds re-exec the bundled exe. Source installs prefer
    `pythonw.exe`/`pyw.exe`, which are the console-less interpreters — with
    plain `python.exe` a window flashes on screen every time a session starts.
    """
    if getattr(sys, "frozen", False):
        return [sys.executable, "daemon"]

    executable = Path(sys.executable)
    if not executable.exists():
        return None

    if os.name == "nt":
        windowless = executable.with_name(
            "pythonw.exe" if executable.stem.lower() != "py" else "pyw.exe"
        )
        if windowless.exists():
            executable = windowless

    return [str(executable), "-m", "meterhouse", "daemon"]


def _spawn_detached(command: list[str]) -> bool:
    """Start the daemon so it survives this hook and Claude Code itself."""
    kwargs: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "cwd": str(Path.home()),
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS
            | subprocess.CREATE_NEW_PROCESS_GROUP
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    else:
        kwargs["start_new_session"] = True

    try:
        subprocess.Popen(command, **kwargs)  # noqa: S603 - argv built here, not from input
        return True
    except (OSError, ValueError):
        log.warning("could not spawn daemon", extra={"command": command})
        return False


def daemon_is_running(lock_path: Path | None = None) -> bool:
    """True when some process already holds the daemon's single-instance lock.

    Probing by taking the lock and dropping it is safe even though it races a
    daemon starting up at the same instant: the loser of that race exits, and
    whichever side spawns next finds the lock free. The outcome is always
    exactly one daemon, never zero.
    """
    lock = SingleInstanceLock(lock_path)
    if lock.acquire():
        lock.release()
        return False
    return True


def ensure_daemon_running(lock_path: Path | None = None) -> bool:
    """Start the daemon unless one is already up. True if a start was issued."""
    if daemon_is_running(lock_path):
        return False
    command = _daemon_command()
    if not command:
        log.warning("no usable interpreter to start the daemon")
        return False
    return _spawn_detached(command)


def handle(event: str, payload: dict, registry: SessionRegistry | None = None,
           config: AgentConfig | None = None) -> dict:
    """Apply one hook event. Returns a small dict for tests and diagnostics."""
    registry = registry or SessionRegistry()
    config = config or AgentConfig.load().validated()

    session_id = payload.get("session_id") or ""
    transcript = payload.get("transcript_path") or ""
    cwd = payload.get("cwd") or ""

    if event == "session-start":
        registry.open_session(
            session_id,
            cwd=cwd,
            transcript_path=transcript,
            source=payload.get("source") or "",
        )
        return {"event": event, "session_id": session_id,
                "daemon_started": ensure_daemon_running()}

    if event == "session-end":
        registry.close_session(session_id)
        # No daemon work here — it notices the empty registry on its own next
        # tick and shuts itself down after a final scan. Doing that inline
        # would blow the 1.5s SessionEnd budget for every hook on the machine.
        return {"event": event, "session_id": session_id,
                "remaining": len(registry.active(config.session_idle_timeout_seconds))}

    if event == "keepalive":
        registry.touch(session_id, transcript_path=transcript)
        # The recovery path: if the daemon crashed or was killed mid-session,
        # the user's next prompt brings it back — for this session only, and at
        # no cost at all on a machine where nobody is working.
        return {"event": event, "session_id": session_id,
                "daemon_started": ensure_daemon_running()}

    return {"event": event, "handled": False}


def run(event: str, stream=None) -> int:
    """CLI entry point. Returns an exit code, and that code is always 0.

    See rule 1 in the module docstring: a non-zero exit from a metering hook
    would surface to the user as a Claude Code error, and exit code 2 would
    block their session outright. Metering is never worth that.
    """
    try:
        config = AgentConfig.load().validated()
        configure_logging(level=config.log_level, json_output=config.log_json,
                          log_file=config.resolved_log_file(), stream=False)
    except Exception:  # noqa: BLE001 - logging setup must not break a session
        config = None

    try:
        handle(event, read_hook_input(stream), config=config)
    except Exception:  # noqa: BLE001 - deliberate: see the docstring
        try:
            log.exception("hook failed", extra={"event": event})
        except Exception:  # noqa: BLE001
            pass
    return 0
