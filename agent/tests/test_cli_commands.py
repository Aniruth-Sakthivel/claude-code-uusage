"""Coverage for cli.py's `_run_pending_commands` — the one-shot execution
path used by scheduled `once`/`sync` runs that have no long-lived daemon."""

import meterhouse.cli as cli_mod
from meterhouse.health import HealthState


class FakeClient:
    def __init__(self):
        self.acked = []
        self.reported_health = []

    def ack_command(self, command_id, status, detail=""):
        self.acked.append((command_id, status, detail))
        return {"ok": True}

    def report_health(self, snapshot):
        self.reported_health.append(snapshot)
        return {"ok": True}


def run_commands(commands, tmp_path, monkeypatch, **kwargs):
    client = FakeClient()
    cli_mod._run_pending_commands(
        client, commands, system_id="sys-1", db_path=tmp_path / "usage.db", verbose=False
    )
    return client


def test_stop_and_restart_are_skipped_without_a_daemon(tmp_path, monkeypatch):
    client = run_commands(
        [
            {"id": 1, "action": "stop", "payload": {}},
            {"id": 2, "action": "restart", "payload": {}},
        ],
        tmp_path,
        monkeypatch,
    )
    assert client.acked[0] == (1, "skipped", "stop needs a running daemon; this is a one-shot run")
    assert client.acked[1] == (2, "skipped", "restart needs a running daemon; this is a one-shot run")


def test_pause_and_resume_still_skip(tmp_path, monkeypatch):
    client = run_commands(
        [{"id": 1, "action": "pause", "payload": {}}],
        tmp_path,
        monkeypatch,
    )
    assert client.acked[0][1] == "skipped"


def test_force_sync_runs_for_real(tmp_path, monkeypatch):
    import meterhouse.sync as sync_mod

    calls = []

    def fake_sync_store(store, client, batch_size=500, verbose=False, send_titles=False):
        calls.append(True)
        return {"received": 4, "inserted": 3, "duplicates": 1}

    monkeypatch.setattr(sync_mod, "sync_store", fake_sync_store)

    closed = []

    class FakeStore:
        def close(self):
            closed.append(True)

    monkeypatch.setattr(cli_mod, "Store", lambda path: FakeStore())

    client = run_commands(
        [{"id": 1, "action": "force_sync", "payload": {}}], tmp_path, monkeypatch
    )
    assert calls == [True]
    assert closed == [True]
    assert client.acked[0][1] == "acked"
    assert "3 new" in client.acked[0][2]
    assert "1 dup" in client.acked[0][2]


def test_refresh_data_scans_and_forces_account_report(tmp_path, monkeypatch):
    import meterhouse.scanner as scanner_mod

    scan_calls = []

    def fake_scan(*, system_id, db_path, verbose):
        scan_calls.append(system_id)
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 2}

    # `_run_pending_commands` re-imports `scan` from `.scanner` locally on
    # every call, so the module-level `cli_mod.run_scan` alias must not be
    # patched here — patch the source instead.
    monkeypatch.setattr(scanner_mod, "scan", fake_scan)

    account_calls = []
    monkeypatch.setattr(
        cli_mod,
        "_report_account",
        lambda client, cfg, verbose=True, force=False: account_calls.append(force),
    )

    client = run_commands(
        [{"id": 1, "action": "refresh_data", "payload": {}}], tmp_path, monkeypatch
    )
    assert scan_calls == ["sys-1"]
    assert account_calls == [True]
    assert client.acked[0][1] == "acked"
    assert "2 new events" in client.acked[0][2]


def test_health_check_sends_snapshot_when_state_exists(tmp_path, monkeypatch):
    state = HealthState()
    monkeypatch.setattr(HealthState, "load", classmethod(lambda cls, path=None: state))

    client = run_commands(
        [{"id": 1, "action": "health_check", "payload": {}}], tmp_path, monkeypatch
    )
    assert len(client.reported_health) == 1
    assert client.acked[0][1] == "acked"


def test_health_check_skips_when_no_state_on_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(HealthState, "load", classmethod(lambda cls, path=None: None))

    client = run_commands(
        [{"id": 1, "action": "health_check", "payload": {}}], tmp_path, monkeypatch
    )
    assert client.reported_health == []
    assert client.acked[0][1] == "skipped"


def test_unknown_action_fails(tmp_path, monkeypatch):
    client = run_commands(
        [{"id": 1, "action": "levitate", "payload": {}}], tmp_path, monkeypatch
    )
    assert client.acked[0][1] == "failed"
