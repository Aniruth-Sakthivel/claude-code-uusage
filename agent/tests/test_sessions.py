import json
import os
import time
from datetime import datetime, timedelta, timezone

from meterhouse.sessions import SessionRecord, SessionRegistry


def registry(tmp_path) -> SessionRegistry:
    return SessionRegistry(tmp_path / "sessions")


def test_open_and_active(tmp_path):
    reg = registry(tmp_path)
    reg.open_session("abc123", cwd="/work/proj", source="startup")

    live = reg.active(300)
    assert [r.session_id for r in live] == ["abc123"]
    assert live[0].cwd == "/work/proj"


def test_close_removes_the_session(tmp_path):
    reg = registry(tmp_path)
    reg.open_session("abc123")
    assert reg.close_session("abc123") is True
    assert reg.active(300) == []
    # Closing twice is what happens when SessionEnd fires after a reap.
    assert reg.close_session("abc123") is False


def test_reopen_preserves_started_at(tmp_path):
    """SessionStart fires again on clear/compact/resume for the same session."""
    reg = registry(tmp_path)
    first = reg.open_session("abc123")
    time.sleep(0.01)
    second = reg.open_session("abc123", source="compact")

    assert second.started_at == first.started_at
    assert second.last_activity_at >= first.last_activity_at
    assert len(reg.all_records()) == 1


def test_touch_creates_a_missing_record(tmp_path):
    """Hooks installed mid-session deliver a prompt for a session we never saw;
    that session is live and must not be discarded."""
    reg = registry(tmp_path)
    assert reg.touch("never-seen") is not None
    assert [r.session_id for r in reg.active(300)] == ["never-seen"]


def test_idle_session_is_not_active_and_is_reaped(tmp_path):
    """Claude Code that was killed never fires SessionEnd."""
    reg = registry(tmp_path)
    reg.open_session("stale")

    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    path = tmp_path / "sessions" / "stale.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["last_activity_at"] = old
    data["started_at"] = old
    path.write_text(json.dumps(data), encoding="utf-8")

    assert reg.active(300) == []
    assert reg.reap_stale(300) == 1
    assert reg.all_records() == []


def test_recent_transcript_keeps_a_quiet_session_alive(tmp_path):
    """A long agent turn writes to the transcript but submits no prompt; the
    daemon must not exit out from under it."""
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("{}", encoding="utf-8")

    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    record = SessionRecord(
        session_id="busy",
        transcript_path=str(transcript),
        started_at=old,
        last_activity_at=old,
    )
    assert record.age_seconds() < 60

    # ...and once the transcript goes quiet too, the session is stale.
    stale_time = time.time() - 7200
    os.utime(transcript, (stale_time, stale_time))
    assert record.age_seconds() > 300


def test_unsafe_session_ids_are_refused(tmp_path):
    """Ids arrive from hook JSON and become filenames."""
    reg = registry(tmp_path)
    for bad in ("../escape", "a/b", "", "x" * 200, None):
        assert reg.open_session(bad) is None
        assert reg.touch(bad) is None
        assert reg.close_session(bad) is False
    assert reg.all_records() == []


def test_corrupt_record_is_skipped_not_fatal(tmp_path):
    reg = registry(tmp_path)
    reg.open_session("good")
    (tmp_path / "sessions" / "broken.json").write_text("{not json", encoding="utf-8")

    assert [r.session_id for r in reg.all_records()] == ["good"]


def test_missing_directory_reads_as_no_sessions(tmp_path):
    assert SessionRegistry(tmp_path / "nope").active(300) == []


def test_concurrent_sessions_are_tracked_separately(tmp_path):
    reg = registry(tmp_path)
    reg.open_session("one", cwd="/a")
    reg.open_session("two", cwd="/b")

    assert len(reg.active(300)) == 2
    reg.close_session("one")
    assert [r.session_id for r in reg.active(300)] == ["two"]
