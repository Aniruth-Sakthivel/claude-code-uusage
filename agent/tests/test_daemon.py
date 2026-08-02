import asyncio

import meterhouse.daemon as daemon_mod
from meterhouse.config import AgentConfig
from meterhouse.daemon import Daemon
from meterhouse.identity import Identity


def make_identity(tmp_path) -> Identity:
    return Identity(
        system_id="sys-1",
        installation_id="inst-1",
        hostname="test-host",
        display_name="test-pc",
        agent_version="0.1.0",
        created_at="2026-07-25T00:00:00+00:00",
    )


def test_scan_once_runs_and_records_health(tmp_path, monkeypatch):
    calls = []

    def fake_scan(*, system_id, db_path, verbose):
        calls.append(system_id)
        return {"new": 1, "updated": 0, "skipped": 0, "events_inserted": 3}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)

    ident = make_identity(tmp_path)
    d = Daemon(AgentConfig(), ident, db_path=tmp_path / "usage.db")

    result = asyncio.run(d._scan_once(trigger="test"))
    assert result == {"new": 1, "updated": 0, "skipped": 0, "events_inserted": 3}
    assert calls == ["sys-1"]
    assert d._health.scans_completed == 1
    assert d._health.last_scan_error is None


def test_scan_once_skips_when_already_running(tmp_path, monkeypatch):
    def fake_scan(*, system_id, db_path, verbose):
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)

    ident = make_identity(tmp_path)
    d = Daemon(AgentConfig(), ident, db_path=tmp_path / "usage.db")

    async def scenario():
        await d._scan_lock.acquire()
        try:
            result = await d._scan_once(trigger="overlap-test")
            assert result is None  # skipped, not queued
        finally:
            d._scan_lock.release()

    asyncio.run(scenario())


def test_scan_once_records_error_without_raising(tmp_path, monkeypatch):
    def fake_scan(*, system_id, db_path, verbose):
        raise RuntimeError("disk full")

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)

    ident = make_identity(tmp_path)
    d = Daemon(AgentConfig(), ident, db_path=tmp_path / "usage.db")

    result = asyncio.run(d._scan_once(trigger="test"))
    assert result is None
    assert d._health.scans_failed == 1
    assert "disk full" in d._health.last_scan_error


def test_sync_skipped_without_server_config(tmp_path, monkeypatch):
    ident = make_identity(tmp_path)  # no server_url/api_key set
    d = Daemon(AgentConfig(), ident, db_path=tmp_path / "usage.db")

    def fail_if_called(*a, **k):
        raise AssertionError("sync should not run without central-mode config")

    import meterhouse.sync as sync_mod
    monkeypatch.setattr(sync_mod, "sync_store", fail_if_called)

    asyncio.run(d._sync_once())  # should return silently, not raise


def make_central_identity(tmp_path) -> Identity:
    ident = make_identity(tmp_path)
    ident.server_url = "https://central.example"
    ident.api_key = "cfk_test"
    return ident


def test_command_pause_stops_scheduled_scans_but_not_manual(tmp_path, monkeypatch):
    calls = []

    def fake_scan(*, system_id, db_path, verbose):
        calls.append(True)
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)
    d = Daemon(AgentConfig(), make_identity(tmp_path), db_path=tmp_path / "usage.db")

    async def scenario():
        status, detail = await d._execute_command({"action": "pause"})
        assert status == "acked"
        assert d._paused.is_set()

        # Scheduled ticks are skipped while paused...
        result = await d._scan_once(trigger="schedule")
        assert result is None
        assert calls == []

        # ...but an explicit scan_now command still runs.
        status, _ = await d._execute_command({"action": "scan_now"})
        assert status == "acked"
        await asyncio.sleep(0)  # let the fire-and-forget scan task run
        assert calls == [True]

        status, detail = await d._execute_command({"action": "resume"})
        assert status == "acked"
        assert not d._paused.is_set()

    asyncio.run(scenario())


def test_command_set_config_applies_allowlisted_fields_only(tmp_path):
    cfg = AgentConfig()
    saved = []
    cfg.save = lambda path=None: saved.append(True)  # avoid touching the real config file
    d = Daemon(cfg, make_identity(tmp_path), db_path=tmp_path / "usage.db")

    async def scenario():
        status, detail = await d._execute_command({
            "action": "set_config",
            "payload": {"scan_interval_seconds": 30, "not_a_real_field": "x"},
        })
        assert status == "acked"
        assert "scan_interval_seconds" in detail
        assert "not_a_real_field" not in detail

    asyncio.run(scenario())
    assert d._cfg.scan_interval_seconds == 30
    assert saved == [True]


def test_command_unknown_action_reports_failed(tmp_path):
    d = Daemon(AgentConfig(), make_identity(tmp_path), db_path=tmp_path / "usage.db")
    status, detail = asyncio.run(d._execute_command({"action": "reboot_the_planet"}))
    assert status == "failed"
    assert "reboot_the_planet" in detail


def test_run_command_acks_over_rest_when_id_present(tmp_path, monkeypatch):
    acks = []

    import meterhouse.sync as sync_mod

    def fake_ack(self, command_id, status, detail=""):
        acks.append((command_id, status, detail))
        return {"ok": True}

    monkeypatch.setattr(sync_mod.SyncClient, "ack_command", fake_ack)

    d = Daemon(AgentConfig(), make_central_identity(tmp_path), db_path=tmp_path / "usage.db")
    asyncio.run(d._run_command({"id": 42, "action": "resume"}))

    assert acks == [(42, "acked", "scan loop resumed")]


def test_poll_commands_dispatches_each_pending_command(tmp_path, monkeypatch):
    executed = []

    async def fake_execute(message):
        executed.append(message["action"])
        return "acked", "ok"

    d = Daemon(AgentConfig(), make_central_identity(tmp_path), db_path=tmp_path / "usage.db")
    monkeypatch.setattr(d, "_execute_command", fake_execute)
    monkeypatch.setattr(d, "_ack_command", lambda *a, **k: None)

    class FakeClient:
        def heartbeat(self):
            return {"ok": True, "commands": [
                {"id": 1, "action": "pause", "payload": {}},
                {"id": 2, "action": "resume", "payload": {}},
            ]}

    asyncio.run(d._poll_commands(FakeClient()))
    assert executed == ["pause", "resume"]
