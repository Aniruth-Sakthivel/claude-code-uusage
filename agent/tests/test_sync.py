import json
import urllib.error
from unittest.mock import patch

import pytest

from meterhouse.sync import SyncClient, SyncError, row_to_event, sync_store, warn_if_insecure


class _FakeResponse:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeStore:
    """In-memory stand-in for meterhouse.store.Store, just enough for sync_store."""

    def __init__(self, events=None, prompts=None, titles=None):
        self._events = list(events or [])
        self._prompts = list(prompts or [])
        self._titles = list(titles or [])
        self.synced_event_ids: list[str] = []
        self.synced_prompt_pairs: list[tuple[str, str]] = []
        self.synced_title_ids: list[str] = []

    def unsynced_events(self, limit=500):
        return self._events[:limit]

    def mark_synced(self, event_ids):
        self.synced_event_ids.extend(event_ids)
        self._events = [e for e in self._events if e["event_id"] not in event_ids]

    def unsynced_prompt_counts(self, limit=500):
        return self._prompts[:limit]

    def mark_prompts_synced(self, pairs):
        self.synced_prompt_pairs.extend(pairs)

    def unsynced_titles(self, limit=500):
        return self._titles[:limit]

    def mark_titles_synced(self, session_ids):
        self.synced_title_ids.extend(session_ids)


def event_row(event_id="sys-1:abc", **overrides):
    row = {
        "event_id": event_id,
        "session_id": "s1",
        "project_name": "proj",
        "ts_utc": "2026-08-02T00:00:00Z",
        "day": "2026-08-02",
        "model": "claude-opus-4-8",
        "model_family": "opus",
        "input_tokens": 10,
        "output_tokens": 5,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "total_tokens": 15,
        "tool_name": None,
        "is_subagent": 0,
        "agent_id": None,
    }
    row.update(overrides)
    return row


# ── row_to_event ─────────────────────────────────────────────────────────────

def test_row_to_event_strips_system_id_prefix():
    ev = row_to_event(event_row(event_id="sys-1:abc123"))
    assert ev["suffix"] == "abc123"


def test_row_to_event_keeps_id_without_prefix():
    ev = row_to_event(event_row(event_id="no-colon-here"))
    assert ev["suffix"] == "no-colon-here"


# ── SyncClient._post ──────────────────────────────────────────────────────────

def test_post_success_returns_parsed_json():
    client = SyncClient("https://api.example.com", "key-1")
    with patch("urllib.request.urlopen", return_value=_FakeResponse({"ok": True})):
        result = client.heartbeat()
    assert result == {"ok": True}


def test_post_sends_bearer_auth_header():
    client = SyncClient("https://api.example.com", "key-1")
    captured = {}

    def fake_urlopen(req, timeout):
        captured["headers"] = dict(req.header_items())
        return _FakeResponse({})

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        client.heartbeat()
    assert captured["headers"]["Authorization"] == "Bearer key-1"


def test_post_http_error_raises_sync_error():
    client = SyncClient("https://api.example.com", "key-1")
    err = urllib.error.HTTPError(
        "https://api.example.com/x", 401, "Unauthorized", {}, None
    )
    err.read = lambda: b"bad key"
    with patch("urllib.request.urlopen", side_effect=err):
        with pytest.raises(SyncError, match="401"):
            client.heartbeat()


def test_post_url_error_raises_sync_error():
    client = SyncClient("https://api.example.com", "key-1")
    with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("no route")):
        with pytest.raises(SyncError, match="cannot reach"):
            client.heartbeat()


# ── SyncClient.ack_command ──────────────────────────────────────────────────

def test_ack_command_posts_to_command_specific_path():
    client = SyncClient("https://api.example.com", "key-1")
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse({"ok": True})

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = client.ack_command(42, "acked", "scan queued")

    assert result == {"ok": True}
    assert captured["url"] == "https://api.example.com/api/v1/systems/commands/42/ack"
    assert captured["body"] == {"status": "acked", "detail": "scan queued"}


def test_ack_command_truncates_oversized_detail():
    client = SyncClient("https://api.example.com", "key-1")
    captured = {}

    def fake_urlopen(req, timeout):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse({"ok": True})

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        client.ack_command(1, "failed", "x" * 3000)

    assert len(captured["body"]["detail"]) == 2000


# ── SyncClient.report_health ────────────────────────────────────────────────

def test_report_health_posts_to_health_endpoint():
    client = SyncClient("https://api.example.com", "key-1")
    captured = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResponse({"ok": True})

    snapshot = {"scans_completed": 3, "scans_failed": 0, "ws_connected": True}
    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = client.report_health(snapshot)

    assert result == {"ok": True}
    assert captured["url"] == "https://api.example.com/api/v1/systems/health"
    assert captured["body"] == snapshot


# ── sync_store ────────────────────────────────────────────────────────────────

def test_sync_store_marks_events_synced_after_push():
    store = FakeStore(events=[event_row("sys-1:a"), event_row("sys-1:b")])
    client = SyncClient("https://api.example.com", "key-1")
    with patch("urllib.request.urlopen", return_value=_FakeResponse(
            {"received": 2, "inserted": 2, "duplicates": 0})):
        totals = sync_store(store, client, batch_size=500)
    assert totals == {"received": 2, "inserted": 2, "duplicates": 0}
    assert store.synced_event_ids == ["sys-1:a", "sys-1:b"]


def test_sync_store_paginates_in_batches():
    rows = [event_row(f"sys-1:{i}") for i in range(5)]
    store = FakeStore(events=rows)
    client = SyncClient("https://api.example.com", "key-1")
    calls = []

    def fake_push(events, prompts=None, session_titles=None):
        calls.append(len(events))
        return {"received": len(events), "inserted": len(events), "duplicates": 0}

    with patch.object(client, "push", side_effect=fake_push):
        totals = sync_store(store, client, batch_size=2)

    assert calls == [2, 2, 1]
    assert totals["inserted"] == 5
    assert store.synced_event_ids == [f"sys-1:{i}" for i in range(5)]


def test_sync_store_sends_prompts_and_titles_on_first_batch_only():
    store = FakeStore(
        events=[event_row("sys-1:a")],
        prompts=[{"session_id": "s1", "day": "2026-08-02", "prompt_count": 3}],
        titles=[{"session_id": "s1", "title": "Fix the bug"}],
    )
    client = SyncClient("https://api.example.com", "key-1")
    payloads = []

    def fake_push(events, prompts=None, session_titles=None):
        payloads.append((prompts, session_titles))
        return {"received": len(events), "inserted": len(events), "duplicates": 0}

    with patch.object(client, "push", side_effect=fake_push):
        sync_store(store, client, batch_size=500, send_titles=True)

    assert len(payloads) == 1  # only one batch: 1 event < batch_size
    prompts, titles = payloads[0]
    assert prompts == [{"session_id": "s1", "day": "2026-08-02", "prompt_count": 3}]
    assert titles == [{"session_id": "s1", "title": "Fix the bug"}]
    assert store.synced_prompt_pairs == [("s1", "2026-08-02")]
    assert store.synced_title_ids == ["s1"]


def test_sync_store_omits_titles_when_send_titles_false():
    store = FakeStore(
        events=[event_row("sys-1:a")],
        titles=[{"session_id": "s1", "title": "Should not be read"}],
    )
    client = SyncClient("https://api.example.com", "key-1")

    def fake_push(events, prompts=None, session_titles=None):
        assert session_titles == []
        return {"received": 1, "inserted": 1, "duplicates": 0}

    with patch.object(client, "push", side_effect=fake_push):
        sync_store(store, client, batch_size=500, send_titles=False)
    assert store.synced_title_ids == []


def test_sync_store_noop_when_nothing_unsynced():
    store = FakeStore()
    client = SyncClient("https://api.example.com", "key-1")
    with patch.object(client, "push") as fake_push:
        totals = sync_store(store, client)
    fake_push.assert_not_called()
    assert totals == {"received": 0, "inserted": 0, "duplicates": 0}


def test_sync_store_propagates_sync_error_leaving_events_unmarked():
    store = FakeStore(events=[event_row("sys-1:a")])
    client = SyncClient("https://api.example.com", "key-1")
    with patch.object(client, "push", side_effect=SyncError("offline")):
        with pytest.raises(SyncError):
            sync_store(store, client)
    assert store.synced_event_ids == []


# ── warn_if_insecure ──────────────────────────────────────────────────────────

def test_warn_if_insecure_allows_https():
    assert warn_if_insecure("https://api.example.com") is None


def test_warn_if_insecure_allows_localhost_http():
    assert warn_if_insecure("http://localhost:8000") is None
    assert warn_if_insecure("http://127.0.0.1:8000") is None


def test_warn_if_insecure_flags_remote_http():
    warning = warn_if_insecure("http://api.example.com")
    assert warning is not None
    assert "cleartext" in warning


def test_warn_if_insecure_allows_wss():
    assert warn_if_insecure("wss://api.example.com/ws") is None


def test_warn_if_insecure_flags_remote_ws():
    warning = warn_if_insecure("ws://api.example.com/ws")
    assert warning is not None
    assert "wss" in warning


def test_warn_if_insecure_allows_localhost_ws():
    assert warn_if_insecure("ws://localhost:8000/ws") is None
