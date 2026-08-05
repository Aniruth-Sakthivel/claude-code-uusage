"""Activity detection: the daemon scans when someone starts using Claude,
instead of making them wait out the interval.
"""

import os
import time

from meterhouse.activity import ActivityWatcher


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_first_check_primes_and_reports_nothing(tmp_path):
    write(tmp_path / "proj" / "a.jsonl", '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    # A scan runs at startup regardless, so the baseline must not also trigger.
    assert w.changed() is False


def test_appending_to_a_transcript_is_activity(tmp_path):
    f = tmp_path / "proj" / "a.jsonl"
    write(f, '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    w.changed()

    with f.open("a", encoding="utf-8") as fh:
        fh.write('{"x":2}\n')
    assert w.changed() is True


def test_a_new_session_file_is_activity(tmp_path):
    write(tmp_path / "proj" / "a.jsonl", '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    w.changed()

    write(tmp_path / "proj" / "b.jsonl", '{"x":1}\n')
    assert w.changed() is True


def test_idle_reports_no_activity(tmp_path):
    write(tmp_path / "proj" / "a.jsonl", '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    w.changed()
    assert w.changed() is False
    assert w.changed() is False


def test_change_is_reported_once_not_repeatedly(tmp_path):
    """Otherwise every poll after a single edit would trigger another scan."""
    f = tmp_path / "proj" / "a.jsonl"
    write(f, '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    w.changed()

    with f.open("a", encoding="utf-8") as fh:
        fh.write('{"x":2}\n')
    assert w.changed() is True
    assert w.changed() is False


def test_growth_within_one_mtime_tick_is_still_activity(tmp_path):
    """Claude appends many times a second; a coarse mtime must not hide that."""
    f = tmp_path / "proj" / "a.jsonl"
    write(f, '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    w.changed()

    with f.open("a", encoding="utf-8") as fh:
        fh.write('{"x":2}\n')
    # Force the timestamp back to what it was, leaving only the size difference.
    st = os.stat(f)
    os.utime(f, ns=(st.st_atime_ns, w._seen[str(f)][0]))
    assert w.changed() is True


def test_deleting_a_transcript_is_activity(tmp_path):
    f = tmp_path / "proj" / "a.jsonl"
    write(f, '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    w.changed()

    f.unlink()
    assert w.changed() is True


def test_missing_directory_is_not_an_error(tmp_path):
    w = ActivityWatcher(project_dirs=[tmp_path / "nope"])
    assert w.changed() is False
    assert w.changed() is False


def test_mark_scanned_absorbs_writes_made_during_the_scan(tmp_path):
    f = tmp_path / "proj" / "a.jsonl"
    write(f, '{"x":1}\n')
    w = ActivityWatcher(project_dirs=[tmp_path])
    w.changed()

    with f.open("a", encoding="utf-8") as fh:
        fh.write('{"x":2}\n')
    time.sleep(0.01)
    w.mark_scanned()  # the scan just ingested that write
    assert w.changed() is False
