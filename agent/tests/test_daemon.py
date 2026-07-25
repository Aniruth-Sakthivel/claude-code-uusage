import asyncio

import claudefleet.daemon as daemon_mod
from claudefleet.config import AgentConfig
from claudefleet.daemon import Daemon
from claudefleet.identity import Identity


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

    import claudefleet.sync as sync_mod
    monkeypatch.setattr(sync_mod, "sync_store", fail_if_called)

    asyncio.run(d._sync_once())  # should return silently, not raise
