"""Detect that someone is actively using Claude Code, from the transcripts.

The scan loop alone is a fixed timer: start work just after a tick and the
dashboard shows nothing for up to a full interval, which reads as "the agent
isn't working". Watching the transcript files closes that gap — a session that
starts now is scanned within seconds instead of at the next tick.

Deliberately stdlib-only and poll-based (mtime + size), not a filesystem-watch
library:

  - it adds no dependency to an agent that is otherwise pure stdlib;
  - `~/.claude/projects` is a small tree of append-only .jsonl files, so a stat
    sweep is cheap and completely predictable;
  - native watchers on Windows are the part that breaks first on network or
    synced profiles, and a missed event here would silently stop reporting.

Size is compared alongside mtime because Claude Code appends to a transcript
many times a second, and a filesystem with coarse mtime resolution can hand
back an unchanged timestamp for a file that has grown.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from .scanner import DEFAULT_PROJECT_DIRS, discover_files


@dataclass
class ActivityWatcher:
    """Reports whether the transcripts changed since the last check.

    One instance per daemon; :meth:`changed` is the whole interface.
    """

    project_dirs: list = field(default_factory=lambda: list(DEFAULT_PROJECT_DIRS))
    #: path -> (mtime_ns, size). Empty until the first check.
    _seen: dict = field(default_factory=dict)
    _primed: bool = False

    def snapshot(self) -> dict:
        out: dict = {}
        for path in discover_files(self.project_dirs):
            try:
                st = os.stat(path)
            except OSError:
                # Deleted or briefly locked mid-sweep. Skipping it means the
                # next sweep sees a change, which is the safe direction.
                continue
            out[str(path)] = (st.st_mtime_ns, st.st_size)
        return out

    def changed(self) -> bool:
        """True when a transcript was added, removed, or appended to.

        The first call primes the baseline and returns False: at daemon start
        every file looks new, and a scan is about to run anyway.
        """
        current = self.snapshot()
        if not self._primed:
            self._seen = current
            self._primed = True
            return False

        if current != self._seen:
            self._seen = current
            return True
        return False

    def mark_scanned(self) -> None:
        """Re-baseline after a scan, so work done *during* it is not counted
        twice — the scan already ingested it."""
        self._seen = self.snapshot()
        self._primed = True


def count_recent(snapshot: dict, idle_timeout_seconds: float, now: float | None = None) -> int:
    """How many transcripts in a `snapshot()` were touched within the window.

    The "active sessions" proxy for the always-on daemon: with no Claude Code
    hooks feeding a session registry, a recently-modified transcript is the
    best available signal that someone is actively working. It undercounts
    two windows on the same project's transcript as one — an accepted
    tradeoff for not depending on hooks at all.
    """
    now_ns = (now if now is not None else time.time()) * 1_000_000_000
    window_ns = idle_timeout_seconds * 1_000_000_000
    return sum(1 for mtime_ns, _size in snapshot.values() if now_ns - mtime_ns <= window_ns)
