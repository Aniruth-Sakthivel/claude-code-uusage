import asyncio

import meterhouse.daemon as daemon_mod
from meterhouse.config import AgentConfig
from meterhouse.daemon import Daemon
from meterhouse.identity import Identity
from meterhouse.sessions import SessionRegistry


def make_identity(tmp_path) -> Identity:
    return Identity(
        system_id="sys-1",
        installation_id="inst-1",
        hostname="test-host",
        display_name="test-pc",
        agent_version="0.1.0",
        created_at="2026-07-25T00:00:00+00:00",
    )


def make_registry(tmp_path, *session_ids) -> SessionRegistry:
    """A registry isolated from this machine's real Claude Code sessions."""
    registry = SessionRegistry(tmp_path / "sessions")
    for session_id in session_ids:
        registry.open_session(session_id)
    return registry


def make_daemon(tmp_path, cfg=None, ident=None, sessions=("s-1",)) -> Daemon:
    """A daemon with one live session by default, so the scan loop has a
    reason to run without depending on the developer's own machine."""
    return Daemon(
        cfg or AgentConfig(),
        ident or make_identity(tmp_path),
        db_path=tmp_path / "usage.db",
        sessions=make_registry(tmp_path, *sessions),
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


def test_wait_scans_early_when_claude_activity_appears(tmp_path, monkeypatch):
    """Someone starting a session must not wait out a whole interval before
    anything reaches the dashboard."""
    calls = []

    def fake_scan(*, system_id, db_path, verbose):
        calls.append("scan")
        return {"new": 1, "updated": 0, "skipped": 0, "events_inserted": 1}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)
    monkeypatch.setattr(daemon_mod, "ACTIVITY_POLL_SECONDS", 0.01)

    cfg = AgentConfig(scan_interval_seconds=3600)  # far away; only activity can fire
    d = make_daemon(tmp_path, cfg=cfg)

    busy = iter([True])
    d._activity.changed = lambda: next(busy, False)
    d._activity.mark_scanned = lambda: None

    async def scenario():
        waiter = asyncio.create_task(d._wait_for_next_scan())
        await asyncio.sleep(0.2)
        d._stop.set()
        await waiter

    asyncio.run(scenario())
    assert calls == ["scan"]


def test_wait_does_not_scan_early_while_paused(tmp_path, monkeypatch):
    """Pause means pause — activity must not quietly override the operator."""
    calls = []

    def fake_scan(*, system_id, db_path, verbose):
        calls.append("scan")
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)
    monkeypatch.setattr(daemon_mod, "ACTIVITY_POLL_SECONDS", 0.01)

    d = make_daemon(tmp_path, cfg=AgentConfig(scan_interval_seconds=3600))
    d._paused.set()
    d._activity.changed = lambda: True
    d._activity.mark_scanned = lambda: None

    async def scenario():
        waiter = asyncio.create_task(d._wait_for_next_scan())
        await asyncio.sleep(0.15)
        d._stop.set()
        await waiter

    asyncio.run(scenario())
    assert calls == []


def test_wait_returns_false_when_stopping(tmp_path, monkeypatch):
    monkeypatch.setattr(daemon_mod, "ACTIVITY_POLL_SECONDS", 0.01)
    d = make_daemon(tmp_path, cfg=AgentConfig(scan_interval_seconds=3600))
    d._activity.changed = lambda: False

    async def scenario():
        waiter = asyncio.create_task(d._wait_for_next_scan())
        await asyncio.sleep(0.05)
        d._stop.set()
        return await waiter

    assert asyncio.run(scenario()) is False


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


def stub_scan(monkeypatch, calls):
    def fake_scan(*, system_id, db_path, verbose):
        calls.append("scan")
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)


# -- session-scoped lifecycle -------------------------------------------------


def test_scan_loop_runs_while_a_session_is_open(tmp_path, monkeypatch):
    calls = []
    stub_scan(monkeypatch, calls)
    monkeypatch.setattr(daemon_mod, "ACTIVITY_POLL_SECONDS", 0.01)

    d = make_daemon(tmp_path, cfg=AgentConfig(scan_interval_seconds=3600))
    d._activity.changed = lambda: False
    d._activity.mark_scanned = lambda: None

    async def scenario():
        loop_task = asyncio.create_task(d._scan_loop())
        await asyncio.sleep(0.1)
        assert not loop_task.done()  # still working: the session is live
        d._stop.set()
        await loop_task

    asyncio.run(scenario())
    assert calls == ["scan"]


def test_scan_loop_exits_when_the_last_session_ends(tmp_path, monkeypatch):
    """The whole point: no session, no process."""
    calls = []
    stub_scan(monkeypatch, calls)
    monkeypatch.setattr(daemon_mod, "ACTIVITY_POLL_SECONDS", 0.01)

    cfg = AgentConfig(scan_interval_seconds=3600, shutdown_grace_seconds=0)
    d = make_daemon(tmp_path, cfg=cfg)
    d._activity.changed = lambda: False
    d._activity.mark_scanned = lambda: None

    async def scenario():
        loop_task = asyncio.create_task(d._scan_loop())
        await asyncio.sleep(0.05)
        d._sessions.close_session("s-1")  # the SessionEnd hook's whole job
        await asyncio.wait_for(loop_task, timeout=2)

    asyncio.run(scenario())
    assert d._health.active_sessions == 0


def test_grace_period_survives_closing_one_window_and_opening_another(tmp_path, monkeypatch):
    calls = []
    stub_scan(monkeypatch, calls)

    cfg = AgentConfig(scan_interval_seconds=3600, shutdown_grace_seconds=60)
    d = make_daemon(tmp_path, cfg=cfg)

    d._sessions.close_session("s-1")
    assert d._sessions_live() is True  # inside the grace period

    d._sessions.open_session("s-2")
    assert d._sessions_live() is True
    assert d._idle_since is None  # the timer reset, not merely paused


def test_grace_period_expires_into_shutdown(tmp_path, monkeypatch):
    d = make_daemon(tmp_path, cfg=AgentConfig(shutdown_grace_seconds=0), sessions=())
    assert d._sessions_live() is False


def test_always_on_ignores_the_empty_registry(tmp_path):
    """The escape hatch for machines that cannot register hooks."""
    d = Daemon(
        AgentConfig(always_on=True),
        make_identity(tmp_path),
        db_path=tmp_path / "usage.db",
        sessions=make_registry(tmp_path),
    )
    assert d._sessions_live() is True


def test_shutdown_scans_one_last_time_then_reports_stopped(tmp_path, monkeypatch):
    """The last turn of a session is usually the biggest, and lands after the
    previous scheduled scan — losing it would defeat the whole redesign."""
    calls = []
    stub_scan(monkeypatch, calls)
    reported = []

    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))
    monkeypatch.setattr(
        d, "_report_status_async",
        lambda state, detail="", **kw: reported.append(state) or asyncio.sleep(0),
    )
    monkeypatch.setattr(d, "_sync_once", lambda: asyncio.sleep(0))

    asyncio.run(d._shutdown())

    assert calls == ["scan"]
    assert reported[-1] == "stopped"  # the state the dashboard is left holding
    assert d._health.stopped_at is not None


def test_shutdown_completes_even_when_the_final_scan_fails(tmp_path, monkeypatch):
    def explode(*, system_id, db_path, verbose):
        raise RuntimeError("disk full")

    monkeypatch.setattr(daemon_mod, "run_scan", explode)
    reported = []

    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))
    monkeypatch.setattr(
        d, "_report_status_async",
        lambda state, detail="", **kw: reported.append(state) or asyncio.sleep(0),
    )

    asyncio.run(d._shutdown())
    assert reported[-1] == "stopped"


def test_shutdown_reaps_a_session_that_never_ended(tmp_path, monkeypatch):
    """Claude Code killed outright never fires SessionEnd; a record left behind
    would make the next hook think work was still in progress."""
    calls = []
    stub_scan(monkeypatch, calls)

    cfg = AgentConfig(session_idle_timeout_seconds=30)
    d = make_daemon(tmp_path, cfg=cfg)
    monkeypatch.setattr(d, "_report_status_async", lambda *a, **k: asyncio.sleep(0))

    record_path = tmp_path / "sessions" / "s-1.json"
    import json
    from datetime import datetime, timedelta, timezone
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    data = json.loads(record_path.read_text(encoding="utf-8"))
    data.update(started_at=old, last_activity_at=old)
    record_path.write_text(json.dumps(data), encoding="utf-8")

    asyncio.run(d._shutdown())
    assert d._sessions.all_records() == []


def test_run_does_a_catch_up_scan_and_exits_when_nothing_is_open(tmp_path, monkeypatch):
    """A stale spawn, or the daily catch-up task: do the useful work, then go."""
    calls = []
    stub_scan(monkeypatch, calls)

    d = make_daemon(tmp_path, sessions=())
    monkeypatch.setattr(d, "_report_status_async", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr(d._health, "save", lambda path=None: None)
    monkeypatch.setattr(
        d, "_scan_loop",
        lambda: (_ for _ in ()).throw(AssertionError("must not start the scan loop")),
    )

    asyncio.run(asyncio.wait_for(d.run(), timeout=5))
    assert calls == ["scan"]
    assert d._health.stopped_at is not None


def test_status_reports_carry_the_session_count(tmp_path, monkeypatch):
    sent = []

    import meterhouse.sync as sync_mod

    def fake_report(self, state, detail="", **kwargs):
        sent.append((state, kwargs.get("active_sessions")))
        return {"ok": True}

    monkeypatch.setattr(sync_mod.SyncClient, "report_status", fake_report)

    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))
    d._health.active_sessions = 2
    d._report_status("scanning", "trigger=test")

    assert sent == [("scanning", 2)]


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
