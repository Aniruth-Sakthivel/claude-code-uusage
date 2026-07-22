import json

from claudefleet import scanner
from claudefleet.store import Store
from tests.conftest import SYSTEM_ID, assistant_record


def write_jsonl(path, records):
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n",
                    encoding="utf-8")


def event_count(db):
    s = Store(db)
    try:
        return s.conn.execute("SELECT COUNT(*) c FROM usage_events").fetchone()["c"]
    finally:
        s.close()


def test_scan_new_file(tmp_path):
    proj = tmp_path / "projects"
    proj.mkdir()
    write_jsonl(proj / "a.jsonl", [assistant_record(message_id="m1"),
                                   assistant_record(message_id="m2")])
    db = tmp_path / "usage.db"
    summary = scanner.scan(system_id=SYSTEM_ID, db_path=db, project_dirs=[proj])
    assert summary["new"] == 1
    assert summary["events_inserted"] == 2
    assert event_count(db) == 2


def test_scan_is_incremental_and_idempotent(tmp_path):
    proj = tmp_path / "projects"
    proj.mkdir()
    f = proj / "a.jsonl"
    write_jsonl(f, [assistant_record(message_id="m1")])
    db = tmp_path / "usage.db"

    scanner.scan(system_id=SYSTEM_ID, db_path=db, project_dirs=[proj])
    # second scan, unchanged file -> skipped, no new events
    s2 = scanner.scan(system_id=SYSTEM_ID, db_path=db, project_dirs=[proj])
    assert s2["skipped"] == 1
    assert s2["events_inserted"] == 0
    assert event_count(db) == 1


def test_scan_appends_only_new_lines(tmp_path):
    proj = tmp_path / "projects"
    proj.mkdir()
    f = proj / "a.jsonl"
    write_jsonl(f, [assistant_record(message_id="m1")])
    db = tmp_path / "usage.db"
    scanner.scan(system_id=SYSTEM_ID, db_path=db, project_dirs=[proj])

    # grow the file with one more record
    write_jsonl(f, [assistant_record(message_id="m1"),
                    assistant_record(message_id="m2")])
    summary = scanner.scan(system_id=SYSTEM_ID, db_path=db, project_dirs=[proj])
    assert summary["updated"] == 1
    assert summary["events_inserted"] == 1   # only the new line
    assert event_count(db) == 2


def test_scan_handles_malformed_lines(tmp_path):
    proj = tmp_path / "projects"
    proj.mkdir()
    f = proj / "a.jsonl"
    good = json.dumps(assistant_record(message_id="m1"))
    f.write_text(good + "\n{ broken json\n" + json.dumps(
        assistant_record(message_id="m2")) + "\n", encoding="utf-8")
    db = tmp_path / "usage.db"
    summary = scanner.scan(system_id=SYSTEM_ID, db_path=db, project_dirs=[proj])
    assert summary["events_inserted"] == 2
    assert event_count(db) == 2


def test_scan_empty_and_missing_dirs(tmp_path):
    db = tmp_path / "usage.db"
    summary = scanner.scan(system_id=SYSTEM_ID, db_path=db,
                           project_dirs=[tmp_path / "does-not-exist"])
    assert summary == {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}


def test_multiple_files_across_dirs(tmp_path):
    p1 = tmp_path / "p1"; p1.mkdir()
    p2 = tmp_path / "p2"; p2.mkdir()
    write_jsonl(p1 / "a.jsonl", [assistant_record(message_id="m1")])
    write_jsonl(p2 / "b.jsonl", [assistant_record(message_id="m2")])
    db = tmp_path / "usage.db"
    summary = scanner.scan(system_id=SYSTEM_ID, db_path=db, project_dirs=[p1, p2])
    assert summary["new"] == 2
    assert event_count(db) == 2
