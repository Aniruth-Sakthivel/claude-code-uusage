"""Coverage for `meterhouse connect` — the one-command setup path that
chains register -> scan -> sync -> start daemon -> register scheduled task.

Each step is monkeypatched to a recorder rather than exercised for real:
this test is about orchestration order, not re-testing `cmd_register` /
`cmd_scan` / `cmd_sync` / the daemon spawn helpers, which already have their
own coverage.
"""

import argparse

import meterhouse.cli as cli_mod
import meterhouse.daemon as daemon_mod
import meterhouse.lockfile as lockfile_mod


def make_args(**overrides):
    defaults = dict(
        server="https://example.com",
        api_key="cfk_test",
        display_name="PC-1",
        ws_url=None,
        account=False,
        db=None,
        quiet=True,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def test_connect_runs_every_step_in_order(monkeypatch):
    calls = []

    monkeypatch.setattr(cli_mod, "cmd_register", lambda a: calls.append(("register", a.server)))
    monkeypatch.setattr(
        cli_mod, "cmd_scan",
        lambda a, report_finished=True: calls.append(("scan", report_finished)),
    )
    monkeypatch.setattr(cli_mod, "cmd_sync", lambda a: calls.append(("sync",)))
    monkeypatch.setattr(daemon_mod, "daemon_command", lambda: ["python", "-m", "meterhouse", "daemon"])
    monkeypatch.setattr(daemon_mod, "spawn_detached", lambda cmd: calls.append(("spawn", cmd)) or True)
    monkeypatch.setattr(lockfile_mod, "is_daemon_running", lambda: False)
    monkeypatch.setattr(cli_mod, "_register_supervisor_task", lambda: calls.append(("supervisor",)))
    monkeypatch.setattr(cli_mod.os, "name", "nt")

    cli_mod.cmd_connect(make_args())

    kinds = [c[0] for c in calls]
    assert kinds == ["register", "scan", "sync", "spawn", "supervisor"]
    assert calls[0] == ("register", "https://example.com")
    assert calls[1] == ("scan", False)  # sync (next step) reports the terminal state


def test_connect_enables_account_reporting_when_requested(monkeypatch, tmp_path):
    monkeypatch.setattr(cli_mod, "cmd_register", lambda a: None)
    monkeypatch.setattr(cli_mod, "cmd_scan", lambda a, report_finished=True: None)
    monkeypatch.setattr(cli_mod, "cmd_sync", lambda a: None)
    monkeypatch.setattr(daemon_mod, "daemon_command", lambda: None)
    monkeypatch.setattr(daemon_mod, "spawn_detached", lambda cmd: True)
    monkeypatch.setattr(lockfile_mod, "is_daemon_running", lambda: True)
    monkeypatch.setattr(cli_mod, "_register_supervisor_task", lambda: None)
    monkeypatch.setenv("METERHOUSE_CONFIG", str(tmp_path / "agent.json"))

    cli_mod.cmd_connect(make_args(account=True))

    from meterhouse.config import AgentConfig
    assert AgentConfig.load().account_reporting_enabled is True


def test_connect_skips_daemon_spawn_when_already_running(monkeypatch):
    spawned = []

    monkeypatch.setattr(cli_mod, "cmd_register", lambda a: None)
    monkeypatch.setattr(cli_mod, "cmd_scan", lambda a, report_finished=True: None)
    monkeypatch.setattr(cli_mod, "cmd_sync", lambda a: None)
    monkeypatch.setattr(daemon_mod, "daemon_command", lambda: ["python", "-m", "meterhouse", "daemon"])
    monkeypatch.setattr(daemon_mod, "spawn_detached", lambda cmd: spawned.append(cmd) or True)
    monkeypatch.setattr(lockfile_mod, "is_daemon_running", lambda: True)
    monkeypatch.setattr(cli_mod, "_register_supervisor_task", lambda: None)

    cli_mod.cmd_connect(make_args())

    assert spawned == []


def test_connect_skips_scheduled_task_off_windows(monkeypatch):
    called = []

    monkeypatch.setattr(cli_mod, "cmd_register", lambda a: None)
    monkeypatch.setattr(cli_mod, "cmd_scan", lambda a, report_finished=True: None)
    monkeypatch.setattr(cli_mod, "cmd_sync", lambda a: None)
    monkeypatch.setattr(daemon_mod, "daemon_command", lambda: None)
    monkeypatch.setattr(daemon_mod, "spawn_detached", lambda cmd: True)
    monkeypatch.setattr(lockfile_mod, "is_daemon_running", lambda: True)
    monkeypatch.setattr(cli_mod, "_register_supervisor_task", lambda: called.append(True))
    monkeypatch.setattr(cli_mod.os, "name", "posix")

    cli_mod.cmd_connect(make_args())

    assert called == []


def test_supervisor_task_script_has_no_repetition_duration(monkeypatch):
    """Regression test for the P99999999DT23H59M59S Task Scheduler bug.

    `[TimeSpan]::MaxValue` passed as `-RepetitionDuration` looks like it means
    "repeat forever", but Task Scheduler serializes it as an ISO 8601 duration
    that overflows the schema's range — the task registers without error and
    then fails every time it tries to run. Omitting the parameter is the fix;
    this locks it down so it can't come back.
    """
    captured = {}

    class FakeResult:
        returncode = 0
        stdout = "VERIFIED:per-user:Ready"
        stderr = ""

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeResult()

    monkeypatch.setattr(daemon_mod, "daemon_command", lambda: ["python", "-m", "meterhouse", "daemon"])

    import subprocess as real_subprocess
    monkeypatch.setattr(real_subprocess, "run", fake_run)

    cli_mod._register_supervisor_task()

    script = captured["cmd"][-1]
    assert "RepetitionDuration" not in script
    assert "MaxValue" not in script
    assert "Get-ScheduledTask" in script


def test_supervisor_task_script_branches_on_elevation(monkeypatch):
    """Regression test for the "Access is denied" bug: registering with an
    explicit Principal (UserId/RunLevel) on a non-elevated shell requires
    rights a standard account doesn't have. The generated script must only
    build a Principal in the elevated branch, and register with none at all
    otherwise.
    """
    captured = {}

    class FakeResult:
        returncode = 0
        stdout = "VERIFIED:per-user:Ready"
        stderr = ""

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakeResult()

    monkeypatch.setattr(daemon_mod, "daemon_command", lambda: ["python", "-m", "meterhouse", "daemon"])

    import subprocess as real_subprocess
    monkeypatch.setattr(real_subprocess, "run", fake_run)

    cli_mod._register_supervisor_task()

    script = captured["cmd"][-1]
    assert "IsInRole" in script and "Administrator" in script
    assert "New-ScheduledTaskPrincipal -UserId 'SYSTEM'" in script
    assert "-Principal $principal -Force" in script  # elevated branch only
    assert "-Trigger @($logon, $repeat) -Force | Out-Null }" in script  # non-elevated: no -Principal


def test_connect_subcommand_is_registered():
    parser = cli_mod.build_parser()
    args = parser.parse_args([
        "connect", "--server", "https://example.com", "--api-key", "cfk_x",
    ])
    assert args.func is cli_mod.cmd_connect
    assert args.account is False
