import io

import meterhouse.hooks as hooks_mod
from meterhouse.config import AgentConfig
from meterhouse.sessions import SessionRegistry


def payload(session_id="s-1", **extra):
    data = {
        "session_id": session_id,
        "transcript_path": "",
        "cwd": "/work/proj",
        "hook_event_name": "SessionStart",
    }
    data.update(extra)
    return data


def no_spawn(monkeypatch):
    """Stop tests from ever launching a real detached daemon."""
    spawned = []
    monkeypatch.setattr(hooks_mod, "daemon_is_running", lambda *a, **k: False)
    monkeypatch.setattr(hooks_mod, "_spawn_detached", lambda cmd: spawned.append(cmd) or True)
    return spawned


def test_session_start_registers_and_starts_daemon(tmp_path, monkeypatch):
    spawned = no_spawn(monkeypatch)
    reg = SessionRegistry(tmp_path / "sessions")

    result = hooks_mod.handle("session-start", payload(source="startup"),
                              registry=reg, config=AgentConfig())

    assert result["daemon_started"] is True
    assert [r.session_id for r in reg.active(300)] == ["s-1"]
    assert len(spawned) == 1


def test_session_start_does_not_start_a_second_daemon(tmp_path, monkeypatch):
    """Opening a second window must reuse the running daemon."""
    monkeypatch.setattr(hooks_mod, "daemon_is_running", lambda *a, **k: True)
    monkeypatch.setattr(
        hooks_mod, "_spawn_detached",
        lambda cmd: (_ for _ in ()).throw(AssertionError("must not spawn")),
    )
    reg = SessionRegistry(tmp_path / "sessions")

    result = hooks_mod.handle("session-start", payload("s-2"), registry=reg, config=AgentConfig())
    assert result["daemon_started"] is False


def test_session_end_deregisters_without_touching_the_daemon(tmp_path, monkeypatch):
    """SessionEnd hooks share a ~1.5s budget: no scan, no sync, no spawn."""
    monkeypatch.setattr(
        hooks_mod, "ensure_daemon_running",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not touch the daemon")),
    )
    reg = SessionRegistry(tmp_path / "sessions")
    reg.open_session("s-1")
    reg.open_session("s-2")

    result = hooks_mod.handle("session-end", payload("s-1"), registry=reg, config=AgentConfig())

    assert result["remaining"] == 1
    assert [r.session_id for r in reg.active(300)] == ["s-2"]


def test_keepalive_refreshes_and_restarts_a_dead_daemon(tmp_path, monkeypatch):
    spawned = no_spawn(monkeypatch)
    reg = SessionRegistry(tmp_path / "sessions")
    opened = reg.open_session("s-1")

    result = hooks_mod.handle("keepalive", payload("s-1"), registry=reg, config=AgentConfig())

    assert result["daemon_started"] is True  # crash recovery
    assert len(spawned) == 1
    refreshed = reg.active(300)[0]
    assert refreshed.last_activity_at >= opened.last_activity_at


def test_read_hook_input_tolerates_garbage():
    assert hooks_mod.read_hook_input(io.StringIO("")) == {}
    assert hooks_mod.read_hook_input(io.StringIO("   ")) == {}
    assert hooks_mod.read_hook_input(io.StringIO("not json")) == {}
    assert hooks_mod.read_hook_input(io.StringIO("[1,2]")) == {}
    assert hooks_mod.read_hook_input(io.StringIO('{"session_id":"x"}')) == {"session_id": "x"}


def test_run_never_fails_and_never_prints(tmp_path, monkeypatch, capsys):
    """A metering hook that exits non-zero or writes to stdout corrupts the
    user's Claude Code session — stdout is injected into the model's context."""
    monkeypatch.setenv("METERHOUSE_SESSIONS_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("METERHOUSE_RUNTIME_CONFIG", str(tmp_path / "runtime.json"))
    monkeypatch.setenv("METERHOUSE_LOG_FILE", str(tmp_path / "agent.log"))

    def explode(*a, **k):
        raise RuntimeError("registry on fire")

    monkeypatch.setattr(hooks_mod, "handle", explode)

    assert hooks_mod.run("session-start", io.StringIO('{"session_id":"s-1"}')) == 0
    assert capsys.readouterr().out == ""


def test_run_with_unparseable_stdin_still_succeeds(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("METERHOUSE_SESSIONS_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("METERHOUSE_RUNTIME_CONFIG", str(tmp_path / "runtime.json"))
    monkeypatch.setenv("METERHOUSE_LOG_FILE", str(tmp_path / "agent.log"))
    monkeypatch.setattr(hooks_mod, "ensure_daemon_running", lambda *a, **k: False)

    assert hooks_mod.run("session-start", io.StringIO("<<garbage>>")) == 0
    assert capsys.readouterr().out == ""


def test_unknown_event_is_ignored(tmp_path):
    reg = SessionRegistry(tmp_path / "sessions")
    result = hooks_mod.handle("nonsense", payload(), registry=reg, config=AgentConfig())
    assert result["handled"] is False
    assert reg.all_records() == []


def test_daemon_command_is_windowless_on_windows(monkeypatch):
    command = hooks_mod._daemon_command()
    assert command is not None
    assert command[-1] == "daemon"
    # A console window must never flash on screen when a session starts.
    assert "python.exe" not in command[0].lower()
