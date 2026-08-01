from meterhouse import parser
from tests.conftest import SYSTEM_ID, assistant_record


def test_token_extraction():
    r = assistant_record(inp=100, out=50, cache_read=10, cache_creation=5)
    res = parser.parse_records([r], system_id=SYSTEM_ID)
    assert len(res.events) == 1
    e = res.events[0]
    assert (e["input_tokens"], e["output_tokens"],
            e["cache_read_tokens"], e["cache_creation_tokens"]) == (100, 50, 10, 5)
    assert e["total_tokens"] == 165
    assert e["model_family"] == "opus"


def test_zero_token_records_skipped():
    r = assistant_record(inp=0, out=0, cache_read=0, cache_creation=0)
    res = parser.parse_records([r], system_id=SYSTEM_ID)
    assert res.events == []


def test_non_assistant_types_ignored_for_events():
    user = {"type": "user", "sessionId": "s1", "timestamp": "2026-07-22T10:00:00Z"}
    res = parser.parse_records([user], system_id=SYSTEM_ID)
    assert res.events == []
    assert "s1" in res.sessions  # still tracked as session metadata


def test_streaming_dedup_by_message_id():
    # Two records, same message id, second has the final tally -> one event.
    r1 = assistant_record(message_id="m1", out=10)
    r2 = assistant_record(message_id="m1", out=80)
    res = parser.parse_records([r1, r2], system_id=SYSTEM_ID)
    assert len(res.events) == 1
    assert res.events[0]["output_tokens"] == 80


def test_different_message_ids_kept_separate():
    res = parser.parse_records(
        [assistant_record(message_id="m1"), assistant_record(message_id="m2")],
        system_id=SYSTEM_ID)
    assert len(res.events) == 2


def test_event_id_is_machine_namespaced_and_stable():
    r = assistant_record(message_id="abc")
    e = parser.parse_records([r], system_id=SYSTEM_ID).events[0]
    assert e["event_id"] == f"{SYSTEM_ID}:abc"
    # different machine -> different id for the same message
    e2 = parser.parse_records([r], system_id="other").events[0]
    assert e2["event_id"] == "other:abc"
    assert e["event_id"] != e2["event_id"]


def test_synthetic_event_id_when_no_message_id():
    r = assistant_record(message_id="")
    e = parser.parse_records([r], system_id=SYSTEM_ID).events[0]
    assert e["event_id"].startswith(f"{SYSTEM_ID}:syn:")
    # deterministic across re-parses
    e2 = parser.parse_records([r], system_id=SYSTEM_ID).events[0]
    assert e["event_id"] == e2["event_id"]


def test_timestamp_normalized_to_utc():
    r = assistant_record(ts="2026-07-22T12:00:00+02:00")
    e = parser.parse_records([r], system_id=SYSTEM_ID).events[0]
    assert e["ts_utc"].startswith("2026-07-22T10:00:00")  # +02:00 -> UTC
    assert e["day"] == "2026-07-22"


def test_bad_timestamp_kept_raw():
    r = assistant_record(ts="not-a-date")
    e = parser.parse_records([r], system_id=SYSTEM_ID).events[0]
    assert e["ts_utc"] == "not-a-date"


def test_project_name_from_cwd():
    assert parser.project_name_from_cwd("/home/u/Github/proj") == "Github/proj"
    assert parser.project_name_from_cwd("C:\\Users\\a\\dev\\app") == "dev/app"
    assert parser.project_name_from_cwd("") == "unknown"
    assert parser.project_name_from_cwd(None) == "unknown"


def test_tool_name_extracted():
    r = assistant_record(tool_name="Bash")
    e = parser.parse_records([r], system_id=SYSTEM_ID).events[0]
    assert e["tool_name"] == "Bash"


def test_subagent_detection():
    r = assistant_record(is_sidechain=True)
    e = parser.parse_records([r], system_id=SYSTEM_ID).events[0]
    assert e["is_subagent"] == 1
    r2 = assistant_record()
    e2 = parser.parse_records([r2], system_id=SYSTEM_ID).events[0]
    assert e2["is_subagent"] == 0


def test_parse_lines_skips_malformed_json():
    good = '{"type":"assistant","sessionId":"s1","timestamp":"2026-07-22T10:00:00Z",' \
           '"message":{"id":"m1","model":"claude-opus-4-8","usage":{"output_tokens":5}}}'
    lines = [good, "{ this is not json", "", good.replace('"m1"', '"m2"')]
    res = parser.parse_lines(lines, system_id=SYSTEM_ID, source_file="f.jsonl")
    assert len(res.events) == 2      # two good records, malformed/blank skipped
    assert res.line_count == 4       # counter still advanced over every line


def test_title_sets_topic_custom_wins():
    recs = [
        {"type": "ai-title", "sessionId": "s1", "aiTitle": "AI name"},
        {"type": "custom-title", "sessionId": "s1", "customTitle": "My name"},
    ]
    res = parser.parse_records(recs, system_id=SYSTEM_ID)
    assert res.sessions["s1"]["topic"] == "My name"


def test_start_line_skips_processed_lines():
    r1 = assistant_record(message_id="m1")
    r2 = assistant_record(message_id="m2")
    res = parser.parse_records([r1, r2], system_id=SYSTEM_ID, start_line=1)
    # first record skipped, only the second becomes an event
    assert len(res.events) == 1
    assert res.events[0]["event_id"].endswith(":m2")
    assert res.line_count == 2
