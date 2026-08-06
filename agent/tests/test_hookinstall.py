import json

from meterhouse.hookinstall import HOOK_EVENTS, MARKER, install, status, uninstall


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_install_adds_all_three_events(tmp_path):
    settings = tmp_path / "settings.json"
    ok, message = install(settings, prefix="meterhouse")

    assert ok, message
    hooks = read(settings)["hooks"]
    for event, arg in HOOK_EVENTS.items():
        handler = hooks[event][0]["hooks"][0]
        assert handler["command"] == f"meterhouse hook {arg}"
        assert handler[MARKER] is True
        # Never block the user's session on metering.
        assert handler["async"] is True


def test_session_end_declares_no_timeout(tmp_path):
    """SessionEnd hooks share a ~1.5s budget; declaring a timeout raises that
    ceiling for every other hook on the machine."""
    settings = tmp_path / "settings.json"
    install(settings, prefix="meterhouse")
    hooks = read(settings)["hooks"]

    assert "timeout" not in hooks["SessionEnd"][0]["hooks"][0]
    assert hooks["SessionStart"][0]["hooks"][0]["timeout"] == 10


def test_install_is_idempotent(tmp_path):
    settings = tmp_path / "settings.json"
    install(settings, prefix="meterhouse")
    install(settings, prefix="meterhouse")

    hooks = read(settings)["hooks"]
    for event in HOOK_EVENTS:
        assert len(hooks[event]) == 1


def test_install_preserves_the_users_own_settings(tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "permissions": {"allow": ["Bash(git *)"]},
        "hooks": {
            "SessionStart": [{"hooks": [{"type": "command", "command": "mine.sh"}]}],
            "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command",
                                                          "command": "guard.sh"}]}],
        },
    }), encoding="utf-8")

    ok, _ = install(settings, prefix="meterhouse")
    assert ok
    data = read(settings)

    assert data["permissions"] == {"allow": ["Bash(git *)"]}
    assert data["hooks"]["PreToolUse"][0]["hooks"][0]["command"] == "guard.sh"
    commands = [h["command"] for g in data["hooks"]["SessionStart"] for h in g["hooks"]]
    assert "mine.sh" in commands
    assert "meterhouse hook session-start" in commands


def test_uninstall_removes_only_ours(tmp_path):
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({
        "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "mine.sh"}]}]}
    }), encoding="utf-8")

    install(settings, prefix="meterhouse")
    ok, message = uninstall(settings)

    assert ok, message
    data = read(settings)
    commands = [h["command"] for g in data["hooks"]["SessionStart"] for h in g["hooks"]]
    assert commands == ["mine.sh"]
    assert "SessionEnd" not in data["hooks"]


def test_uninstall_leaves_no_empty_scaffolding(tmp_path):
    settings = tmp_path / "settings.json"
    install(settings, prefix="meterhouse")
    uninstall(settings)

    assert "hooks" not in read(settings)


def test_unparseable_settings_are_never_overwritten(tmp_path):
    """Clobbering a user's settings.json is far worse than not installing."""
    settings = tmp_path / "settings.json"
    settings.write_text('{"hooks": broken', encoding="utf-8")

    ok, message = install(settings, prefix="meterhouse")

    assert ok is False
    assert "not valid JSON" in message
    assert settings.read_text(encoding="utf-8") == '{"hooks": broken'


def test_status_reports_what_is_registered(tmp_path):
    settings = tmp_path / "settings.json"
    assert status(settings)["installed"] is False

    install(settings, prefix="meterhouse")
    result = status(settings)
    assert result["installed"] is True
    assert all(result["events"].values())


def test_uninstall_on_a_missing_file_is_not_an_error(tmp_path):
    ok, _ = uninstall(tmp_path / "nope.json")
    assert ok is True
