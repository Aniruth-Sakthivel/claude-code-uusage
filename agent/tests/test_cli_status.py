"""The status a one-shot run leaves behind.

This is what decides whether an idle machine reads as dormant or as dead. The
daily catch-up task runs `once` on PCs where nobody opened Claude Code, and if
that leaves a mid-cycle state the dashboard grades the following silence as
stalled and then dead — an alarm on every well-behaved machine in the fleet.
"""

import meterhouse.cli as cli
from meterhouse.config import AgentConfig
from meterhouse.identity import Identity


def make_identity() -> Identity:
    ident = Identity(
        system_id="sys-1",
        installation_id="inst-1",
        hostname="test-host",
        display_name="test-pc",
        agent_version="0.1.0",
        created_at="2026-07-25T00:00:00+00:00",
    )
    ident.server_url = "https://central.example"
    ident.api_key = "cfk_test"
    return ident


def capture(monkeypatch) -> list:
    """Record every status report instead of sending it."""
    sent = []
    import meterhouse.sync as sync_mod

    def fake_report(self, state, detail="", **kwargs):
        sent.append((state, kwargs.get("active_sessions")))
        return {"ok": True}

    monkeypatch.setattr(sync_mod.SyncClient, "report_status", fake_report)
    return sent


def test_finished_reports_stopped_when_nothing_is_open(monkeypatch):
    sent = capture(monkeypatch)
    monkeypatch.setattr(cli, "_active_session_count", lambda: 0)

    cli._report_finished(make_identity(), "synced 3 events")

    assert sent == [("stopped", 0)]


def test_finished_reports_idle_while_a_session_is_live(monkeypatch):
    """A daemon owns the status line during a session; a catch-up run must not
    claim the agent stopped underneath it."""
    sent = capture(monkeypatch)
    monkeypatch.setattr(cli, "_active_session_count", lambda: 2)

    cli._report_finished(make_identity(), "synced 3 events")

    assert sent == [("idle", 2)]


def test_every_status_carries_the_session_count(monkeypatch):
    """Otherwise a one-shot run leaves whatever the daemon last wrote, and a
    stopped machine sits at '1 active session' forever."""
    sent = capture(monkeypatch)
    monkeypatch.setattr(cli, "_active_session_count", lambda: 0)

    cli._status(make_identity(), "scanning", "one-shot scan")

    assert sent == [("scanning", 0)]


def test_scan_ends_on_a_terminal_state(monkeypatch, tmp_path):
    sent = capture(monkeypatch)
    monkeypatch.setattr(cli, "_active_session_count", lambda: 0)
    monkeypatch.setattr(cli, "load_identity", lambda **kw: make_identity())
    monkeypatch.setattr(cli, "run_scan", lambda **kw: {"events_inserted": 0})

    class Args:
        display_name = None
        db = tmp_path / "usage.db"
        quiet = True

    cli.cmd_scan(Args())

    assert [s for s, _ in sent] == ["scanning", "scanned", "stopped"]


def test_once_does_not_report_stopped_before_syncing(monkeypatch, tmp_path):
    """`once` is scan-then-sync; a terminal report between the two would show
    the machine stopping and then starting again."""
    sent = capture(monkeypatch)
    monkeypatch.setattr(cli, "_active_session_count", lambda: 0)
    monkeypatch.setattr(cli, "load_identity", lambda **kw: make_identity())
    monkeypatch.setattr(cli, "run_scan", lambda **kw: {"events_inserted": 0})

    class Args:
        display_name = None
        db = tmp_path / "usage.db"
        quiet = True

    cli.cmd_scan(Args(), report_finished=False)

    assert [s for s, _ in sent] == ["scanning", "scanned"]


# ── set_config reaches exactly as far on both paths ──────────────────────────


def test_config_patch_ignores_fields_outside_the_allowlist():
    cfg = AgentConfig()
    saved = []
    cfg.save = lambda path=None: saved.append(True)

    applied = cfg.apply_patch({
        "scan_interval_seconds": 30,
        "always_on": True,           # not remotely settable
        "log_file": "/tmp/evil.log", # nor this
        "made_up": 1,
    })

    assert applied == ["scan_interval_seconds"]
    assert cfg.always_on is False
    assert cfg.log_file is None
    assert saved == [True]


def test_config_patch_clamps_out_of_range_values():
    """The CLI path used to skip validation entirely, so a push of
    scan_interval_seconds=0 persisted and produced a hot loop."""
    cfg = AgentConfig()
    cfg.save = lambda path=None: None

    cfg.apply_patch({"scan_interval_seconds": 0, "session_idle_timeout_seconds": 1})

    assert cfg.scan_interval_seconds == 5
    assert cfg.session_idle_timeout_seconds == 30


def test_config_patch_with_nothing_recognised_saves_nothing():
    cfg = AgentConfig()
    saved = []
    cfg.save = lambda path=None: saved.append(True)

    assert cfg.apply_patch({"made_up": 1}) == []
    assert saved == []
