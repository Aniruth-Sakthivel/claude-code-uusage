from claudefleet import parser
from claudefleet.store import Store
from tests.conftest import SYSTEM_ID, assistant_record


def make_store(tmp_path):
    return Store(tmp_path / "usage.db")


def events(*records):
    return parser.parse_records(list(records), system_id=SYSTEM_ID).events


def test_schema_initialized(tmp_path):
    s = make_store(tmp_path)
    tables = {r["name"] for r in s.conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"meta", "scanned_files", "usage_events"} <= tables
    assert s.get_meta("schema_version") == "1"
    s.close()


def test_insert_events_returns_inserted_count(tmp_path):
    s = make_store(tmp_path)
    n = s.insert_events(events(assistant_record(message_id="m1"),
                               assistant_record(message_id="m2")))
    s.commit()
    assert n == 2
    s.close()


def test_insert_or_ignore_dedups_across_calls(tmp_path):
    # The core no-double-count guarantee: same event_id inserted twice = once.
    s = make_store(tmp_path)
    ev = events(assistant_record(message_id="m1"))
    assert s.insert_events(ev) == 1
    assert s.insert_events(ev) == 0     # duplicate ignored
    s.commit()
    count = s.conn.execute("SELECT COUNT(*) c FROM usage_events").fetchone()["c"]
    assert count == 1
    s.close()


def test_scanned_file_watermark_roundtrip(tmp_path):
    s = make_store(tmp_path)
    assert s.get_scanned_file("f.jsonl") is None
    s.set_scanned_file("f.jsonl", 123.5, 42)
    s.commit()
    row = s.get_scanned_file("f.jsonl")
    assert row["mtime"] == 123.5 and row["line_count"] == 42
    s.close()


def test_sync_watermark(tmp_path):
    s = make_store(tmp_path)
    s.insert_events(events(assistant_record(message_id="m1"),
                           assistant_record(message_id="m2")))
    s.commit()
    unsynced = s.unsynced_events()
    assert len(unsynced) == 2
    s.mark_synced([unsynced[0]["event_id"]])
    assert len(s.unsynced_events()) == 1
    s.close()
