"""Single-instance guard for the daemon.

The supervising scheduled task relaunches `meterhouse daemon` every few minutes
so a daemon that died (crash, killed by antivirus, machine woken from sleep) is
back within minutes without waiting for the next logon. That only works if a
launch while one is already running is harmless — otherwise every tick would
add another daemon, each scanning and syncing the same machine.

An OS-level advisory lock on a file is used rather than a PID file, because it
needs no liveness check and no cleanup: when the holding process exits for any
reason — including being killed — the kernel drops the lock. (A PID check would
also be actively dangerous on Windows, where `os.kill(pid, 0)` terminates the
target instead of probing it.)

The lock handle must stay referenced for as long as the process should hold the
lock; closing the file releases it.
"""

from __future__ import annotations

import os
from pathlib import Path


def default_lock_path() -> Path:
    env = os.environ.get("METERHOUSE_LOCK_FILE")
    if env:
        return Path(env)
    return Path.home() / ".claude" / "meterhouse" / "daemon.lock"


class SingleInstanceLock:
    """Held for the process lifetime. Use :meth:`acquire` to test for a rival."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path else default_lock_path()
        self._fh = None

    def acquire(self) -> bool:
        """True if this process now holds the lock, False if another one does."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Opened r+ (created if missing) rather than w, so a rival's PID text is
        # not truncated before we know whether we can take the lock.
        fh = open(self.path, "a+", encoding="utf-8")
        try:
            _lock_exclusive_nonblocking(fh)
        except OSError:
            fh.close()
            return False

        self._fh = fh
        try:
            fh.seek(0)
            fh.truncate()
            fh.write(str(os.getpid()))
            fh.flush()
        except OSError:
            pass  # diagnostics only — the lock itself is what matters
        return True

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            _unlock(self._fh)
        except OSError:
            pass
        finally:
            self._fh.close()
            self._fh = None

    def __enter__(self) -> "SingleInstanceLock":
        return self

    def __exit__(self, *exc) -> None:
        self.release()


if os.name == "nt":
    import msvcrt

    def _lock_exclusive_nonblocking(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock(fh) -> None:
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)

else:
    import fcntl

    def _lock_exclusive_nonblocking(fh) -> None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock(fh) -> None:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
