"""Human prompt counting and session titles (schema v2).

The counting rule is the whole point here: records of type `user` are
overwhelmingly tool results, not typed input. Measured on a real transcript,
206 `user` records contained only 10 genuine prompts.
"""

from tests.conftest import SYSTEM_ID, assistant_record

from meterhouse import parser
from meterhouse.store import Store


def user_record(session_id="s1", uuid="u1", ts="2026-07-22T10:00:00.000Z",
                content=None, is_meta=False):
    rec = {
        "type": "user",
        "sessionId": session_id,
        "uuid": uuid,
        "timestamp": ts,
        "cwd": "/home/u/Github/proj",
        "message": {"content": content if content is not None else "hello there"},
    }
    if is_meta:
        rec["isMeta"] = True
    return rec


def parse(*records):
    return parser.parse_records(list(records), system_id=SYSTEM_ID)


def test_counts_a_typed_prompt():
    assert len(parse(user_record()).prompts) == 1


def test_ignores_tool_results():
    """The dominant case — 194 of 206 user records in a real transcript."""
    rec = user_record(content=[{"type": "tool_result", "content": "ok"}])
    assert parse(rec).prompts == []


def test_ignores_mixed_content_containing_a_tool_result():
    rec = user_record(content=[{"type": "text", "text": "hi"}, {"type": "tool_result"}])
    assert parse(rec).prompts == []


def test_ignores_meta_records():
    assert parse(user_record(is_meta=True)).prompts == []


def test_ignores_assistant_turns():
    assert parse(assistant_record()).prompts == []


def test_records_session_and_day():
    prompts = parse(user_record(session_id="abc", ts="2026-07-22T10:00:00.000Z")).prompts
    assert prompts == [("u1", "abc", "2026-07-22")]


def test_record_without_uuid_is_skipped():
    """Without a stable id a re-scan would double-count, so it is dropped."""
    rec = user_record()
    del rec["uuid"]
    assert parse(rec).prompts == []


def test_prompts_are_idempotent_across_rescans(tmp_path):
    s = Store(tmp_path / "u.db")
    rows = parse(user_record(uuid="p1"), user_record(uuid="p2")).prompts
    assert s.insert_prompts(rows) == 2
    assert s.insert_prompts(rows) == 0  # same records again — no double count
    assert s.prompt_total() == 2
    s.close()


def test_unsynced_counts_are_cumulative(tmp_path):
    s = Store(tmp_path / "u.db")
    s.insert_prompts([("p1", "s1", "2026-07-22"), ("p2", "s1", "2026-07-22")])
    rows = s.unsynced_prompt_counts()
    assert [(r["session_id"], r["day"], r["prompt_count"]) for r in rows] == [
        ("s1", "2026-07-22", 2)
    ]

    s.mark_prompts_synced([("s1", "2026-07-22")])
    assert s.unsynced_prompt_counts() == []

    # A later prompt on the same day re-reports the *total*, not the delta, so
    # the server can upsert with MAX() and stay correct under retries.
    s.insert_prompts([("p3", "s1", "2026-07-22")])
    rows = s.unsynced_prompt_counts()
    assert rows[0]["prompt_count"] == 3
    s.close()


def test_titles_stored_and_marked(tmp_path):
    s = Store(tmp_path / "u.db")
    s.upsert_session_titles({"s1": "Migrate billing schema"})
    rows = s.unsynced_titles()
    assert [(r["session_id"], r["title"]) for r in rows] == [("s1", "Migrate billing schema")]

    s.mark_titles_synced(["s1"])
    assert s.unsynced_titles() == []

    # A changed title must go out again.
    s.upsert_session_titles({"s1": "Renamed"})
    s.commit()
    assert [r["title"] for r in s.unsynced_titles()] == ["Renamed"]
    s.close()


def test_titles_are_never_sent_unless_enabled(tmp_path, monkeypatch):
    """`send_titles=False` (the default) must not put titles on the wire."""
    from meterhouse.sync import SyncClient, sync_store

    s = Store(tmp_path / "u.db")
    s.upsert_session_titles({"s1": "Secret project name"})
    s.insert_prompts([("p1", "s1", "2026-07-22")])
    s.commit()

    sent = []
    client = SyncClient("https://example.test", "cfk_x")
    monkeypatch.setattr(
        SyncClient, "_post", lambda self, path, payload: sent.append(payload) or {}
    )

    sync_store(s, client)  # send_titles defaults to False
    body = sent[0]
    assert "session_titles" not in body
    assert "Secret project name" not in str(body)
    # Prompt counts still travel — a number carries no content.
    assert body["prompts"][0]["prompt_count"] == 1
    s.close()


def test_titles_sent_when_enabled(tmp_path, monkeypatch):
    from meterhouse.sync import SyncClient, sync_store

    s = Store(tmp_path / "u.db")
    s.upsert_session_titles({"s1": "Migrate billing schema"})
    s.commit()

    sent = []
    client = SyncClient("https://example.test", "cfk_x")
    monkeypatch.setattr(
        SyncClient, "_post", lambda self, path, payload: sent.append(payload) or {}
    )

    sync_store(s, client, send_titles=True)
    assert sent[0]["session_titles"] == [
        {"session_id": "s1", "title": "Migrate billing schema"}
    ]
    s.close()


def test_titles_flag_defaults_off():
    from meterhouse.config import AgentConfig

    assert AgentConfig().session_titles_enabled is False
