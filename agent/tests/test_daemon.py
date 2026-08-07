import asyncio
import time

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


def make_central_identity(tmp_path) -> Identity:
    ident = make_identity(tmp_path)
    ident.server_url = "https://central.example"
    ident.api_key = "cfk_test"
    return ident


def make_daemon(tmp_path, cfg=None, ident=None) -> Daemon:
    return Daemon(cfg or AgentConfig(), ident or make_identity(tmp_path), db_path=tmp_path / "usage.db")


def stub_scan(monkeypatch, calls, events_inserted=0):
    def fake_scan(*, system_id, db_path, verbose):
        calls.append("scan")
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": events_inserted}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)


def test_scan_once_runs_and_records_health(tmp_path, monkeypatch):
    calls = []

    def fake_scan(*, system_id, db_path, verbose):
        calls.append(system_id)
        return {"new": 1, "updated": 0, "skipped": 0, "events_inserted": 3}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)

    d = make_daemon(tmp_path)
    result = asyncio.run(d._scan_once(trigger="test"))
    assert result == {"new": 1, "updated": 0, "skipped": 0, "events_inserted": 3}
    assert calls == ["sys-1"]
    assert d._health.scans_completed == 1
    assert d._health.last_scan_error is None


def test_scan_once_does_not_sync(tmp_path, monkeypatch):
    """`_scan_once` is scan-only now — the tick loop/`_scan_and_sync` decide
    separately whether a sync round trip happens."""
    stub_scan(monkeypatch, [])
    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))

    synced = []
    monkeypatch.setattr(d, "_sync_once", lambda: synced.append(True) or asyncio.sleep(0))

    asyncio.run(d._scan_once(trigger="test"))
    assert synced == []


def test_scan_once_skips_when_already_running(tmp_path, monkeypatch):
    def fake_scan(*, system_id, db_path, verbose):
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)
    d = make_daemon(tmp_path)

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
    d = make_daemon(tmp_path)

    result = asyncio.run(d._scan_once(trigger="test"))
    assert result is None
    assert d._health.scans_failed == 1
    assert "disk full" in d._health.last_scan_error


def test_scan_and_sync_runs_both_regardless_of_sync_interval(tmp_path, monkeypatch):
    stub_scan(monkeypatch, [])
    d = make_daemon(
        tmp_path,
        cfg=AgentConfig(sync_interval_seconds=3600),  # far away — must sync anyway
        ident=make_central_identity(tmp_path),
    )
    synced = []
    monkeypatch.setattr(d, "_sync_once", lambda: synced.append(True) or asyncio.sleep(0))

    asyncio.run(d._scan_and_sync(trigger="command"))
    assert synced == [True]
    assert d._last_sync_at > 0


def test_sync_skipped_without_server_config(tmp_path, monkeypatch):
    d = make_daemon(tmp_path)  # no server_url/api_key set

    def fail_if_called(*a, **k):
        raise AssertionError("sync should not run without central-mode config")

    import meterhouse.sync as sync_mod
    monkeypatch.setattr(sync_mod, "sync_store", fail_if_called)

    asyncio.run(d._sync_once())  # should return silently, not raise


def test_command_pause_stops_scheduled_scans_but_not_manual(tmp_path, monkeypatch):
    calls = []

    def fake_scan(*, system_id, db_path, verbose):
        calls.append(True)
        return {"new": 0, "updated": 0, "skipped": 0, "events_inserted": 0}

    monkeypatch.setattr(daemon_mod, "run_scan", fake_scan)
    d = make_daemon(tmp_path)

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
    d = make_daemon(tmp_path)
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

    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))
    asyncio.run(d._run_command({"id": 42, "action": "resume"}))

    assert acks == [(42, "acked", "scan loop resumed")]


# -- the always-on tick loop --------------------------------------------------


def test_tick_loop_syncs_immediately_when_something_is_found(tmp_path, monkeypatch):
    stub_scan(monkeypatch, [], events_inserted=1)
    d = make_daemon(
        tmp_path,
        cfg=AgentConfig(scan_interval_seconds=0.01, sync_interval_seconds=3600),
        ident=make_central_identity(tmp_path),
    )
    synced = []
    monkeypatch.setattr(d, "_sync_once", lambda: synced.append(True) or asyncio.sleep(0))

    async def scenario():
        task = asyncio.create_task(d._tick_loop())
        await asyncio.sleep(0.05)
        d._stop.set()
        await task

    asyncio.run(scenario())
    assert synced  # a found-something tick synced despite the huge sync interval


def test_tick_loop_skips_sync_on_a_quiet_tick_before_the_interval(tmp_path, monkeypatch):
    stub_scan(monkeypatch, [], events_inserted=0)
    d = make_daemon(
        tmp_path,
        cfg=AgentConfig(scan_interval_seconds=0.01, sync_interval_seconds=3600),
        ident=make_central_identity(tmp_path),
    )
    d._last_sync_at = time.monotonic()  # pretend we just synced
    synced = []
    monkeypatch.setattr(d, "_sync_once", lambda: synced.append(True) or asyncio.sleep(0))

    async def scenario():
        task = asyncio.create_task(d._tick_loop())
        await asyncio.sleep(0.05)
        d._stop.set()
        await task

    asyncio.run(scenario())
    assert synced == []


def test_tick_loop_syncs_once_the_interval_elapses_even_if_quiet(tmp_path, monkeypatch):
    stub_scan(monkeypatch, [], events_inserted=0)
    d = make_daemon(
        tmp_path,
        cfg=AgentConfig(scan_interval_seconds=0.01, sync_interval_seconds=0.02),
        ident=make_central_identity(tmp_path),
    )
    synced = []
    monkeypatch.setattr(d, "_sync_once", lambda: synced.append(True) or asyncio.sleep(0))

    async def scenario():
        task = asyncio.create_task(d._tick_loop())
        await asyncio.sleep(0.1)
        d._stop.set()
        await task

    asyncio.run(scenario())
    assert synced  # the interval elapsed even though nothing was found


def test_sync_interval_never_faster_than_scan_interval():
    cfg = AgentConfig(scan_interval_seconds=30, sync_interval_seconds=5).validated()
    assert cfg.sync_interval_seconds == 30


# -- shutdown / lifecycle ------------------------------------------------------


def test_shutdown_scans_and_syncs_one_last_time_then_reports_stopped(tmp_path, monkeypatch):
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


def test_run_starts_the_tick_loop_and_stops_on_signal(tmp_path, monkeypatch):
    calls = []
    stub_scan(monkeypatch, calls)
    monkeypatch.setattr(daemon_mod, "HEALTH_HEARTBEAT_SECONDS", 3600)

    d = make_daemon(tmp_path, cfg=AgentConfig(scan_interval_seconds=0.01))
    monkeypatch.setattr(d, "_report_status_async", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr(d._health, "save", lambda path=None: None)

    async def scenario():
        run_task = asyncio.create_task(d.run())
        await asyncio.sleep(0.05)
        assert not run_task.done()  # still looping
        d._stop.set()
        await asyncio.wait_for(run_task, timeout=2)

    asyncio.run(scenario())
    assert calls  # at least one tick ran
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


def test_update_active_sessions_counts_recent_transcripts(tmp_path):
    d = make_daemon(tmp_path)
    project_dir = tmp_path / "projects"
    project_dir.mkdir()
    (project_dir / "a.jsonl").write_text("{}", encoding="utf-8")
    d._activity.project_dirs = [project_dir]

    d._update_active_sessions()
    assert d._health.active_sessions == 1


# -- Trigger commands beyond the basics ---------------------------------------


def test_command_stop_sets_stop_event(tmp_path):
    d = make_daemon(tmp_path)

    async def scenario():
        status, detail = await d._execute_command({"action": "stop"})
        assert status == "acked"
        assert "shutting down" in detail
        assert d._stop.is_set()

    asyncio.run(scenario())


def test_command_force_sync_queues_sync_without_a_scan(tmp_path, monkeypatch):
    called = []
    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))

    async def fake_sync_once():
        called.append("sync")

    monkeypatch.setattr(d, "_sync_once", fake_sync_once)

    async def scenario():
        status, detail = await d._execute_command({"action": "force_sync"})
        assert status == "acked"
        await asyncio.sleep(0)  # let the fire-and-forget task run

    asyncio.run(scenario())
    assert called == ["sync"]


def test_command_refresh_data_queues_scan_and_forced_account_report(tmp_path, monkeypatch):
    called = []
    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))

    async def fake_scan_and_sync(trigger):
        called.append(("scan_and_sync", trigger))

    async def fake_report_account_once(force=False):
        called.append(("account", force))

    monkeypatch.setattr(d, "_scan_and_sync", fake_scan_and_sync)
    monkeypatch.setattr(d, "_report_account_once", fake_report_account_once)

    async def scenario():
        status, detail = await d._execute_command({"action": "refresh_data"})
        assert status == "acked"
        await asyncio.sleep(0)

    asyncio.run(scenario())
    assert ("scan_and_sync", "command") in called
    assert ("account", True) in called


def test_command_restart_spawns_replacement_and_stops(tmp_path, monkeypatch):
    spawned = []
    monkeypatch.setattr(
        daemon_mod, "daemon_command", lambda: ["python", "-m", "meterhouse", "daemon"]
    )
    monkeypatch.setattr(
        daemon_mod, "spawn_detached", lambda cmd: spawned.append(cmd) or True
    )

    d = make_daemon(tmp_path)
    status, detail = asyncio.run(d._execute_command({"action": "restart"}))

    assert status == "acked"
    assert spawned == [["python", "-m", "meterhouse", "daemon"]]
    assert d._stop.is_set()


def test_command_restart_fails_if_it_cannot_spawn(tmp_path, monkeypatch):
    monkeypatch.setattr(
        daemon_mod, "daemon_command", lambda: ["python", "-m", "meterhouse", "daemon"]
    )
    monkeypatch.setattr(daemon_mod, "spawn_detached", lambda cmd: False)

    d = make_daemon(tmp_path)
    status, detail = asyncio.run(d._execute_command({"action": "restart"}))

    assert status == "failed"
    assert not d._stop.is_set()


def test_command_health_check_without_central_config_fails(tmp_path):
    d = make_daemon(tmp_path)
    status, detail = asyncio.run(d._execute_command({"action": "health_check"}))
    assert status == "failed"


def test_command_health_check_queues_snapshot_push(tmp_path, monkeypatch):
    called = []
    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))

    async def fake_push():
        called.append(True)

    monkeypatch.setattr(d, "_push_health_snapshot", fake_push)

    async def scenario():
        status, detail = await d._execute_command({"action": "health_check"})
        assert status == "acked"
        await asyncio.sleep(0)

    asyncio.run(scenario())
    assert called == [True]


def test_poll_commands_dispatches_each_pending_command(tmp_path, monkeypatch):
    executed = []

    async def fake_execute(message):
        executed.append(message["action"])
        return "acked", "ok"

    d = make_daemon(tmp_path, ident=make_central_identity(tmp_path))
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
