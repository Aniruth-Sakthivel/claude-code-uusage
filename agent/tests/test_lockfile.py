"""The single-instance lock is what makes the every-5-minutes supervisor task
safe: a relaunch while a daemon is alive has to be a no-op, not a second agent.
"""

import multiprocessing
import sys

from meterhouse.lockfile import SingleInstanceLock


def test_second_lock_in_same_process_is_refused(tmp_path):
    path = tmp_path / "daemon.lock"
    first = SingleInstanceLock(path)
    assert first.acquire() is True
    try:
        assert SingleInstanceLock(path).acquire() is False
    finally:
        first.release()


def test_lock_is_reusable_after_release(tmp_path):
    path = tmp_path / "daemon.lock"
    first = SingleInstanceLock(path)
    assert first.acquire() is True
    first.release()

    second = SingleInstanceLock(path)
    assert second.acquire() is True
    second.release()


def _try_acquire(path, result):
    result.value = 1 if SingleInstanceLock(path).acquire() else 0


def test_another_process_cannot_take_a_held_lock(tmp_path):
    """The case that matters: the scheduled task launching a rival daemon."""
    if sys.platform == "win32" and multiprocessing.get_start_method() != "spawn":
        return

    path = tmp_path / "daemon.lock"
    held = SingleInstanceLock(path)
    assert held.acquire() is True
    try:
        result = multiprocessing.Value("i", -1)
        proc = multiprocessing.Process(target=_try_acquire, args=(str(path), result))
        proc.start()
        proc.join(timeout=30)
        assert result.value == 0
    finally:
        held.release()


def test_lock_records_the_holding_pid(tmp_path):
    """Written for diagnostics only — read here after release, because a
    Windows lock is mandatory and the locked byte cannot be read while held."""
    import os

    path = tmp_path / "daemon.lock"
    lock = SingleInstanceLock(path)
    assert lock.acquire() is True
    lock.release()
    assert path.read_text(encoding="utf-8").strip() == str(os.getpid())
