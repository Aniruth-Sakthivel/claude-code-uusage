import os

from claudefleet.config import AgentConfig


def test_defaults_when_no_file(tmp_path):
    cfg = AgentConfig.load(tmp_path / "missing.json")
    assert cfg.scan_interval_seconds == 60
    assert cfg.ws_enabled is False


def test_round_trip_save_load(tmp_path):
    path = tmp_path / "runtime.json"
    cfg = AgentConfig(scan_interval_seconds=30, ws_enabled=True, ws_url="wss://example/ws")
    cfg.save(path)

    loaded = AgentConfig.load(path)
    assert loaded.scan_interval_seconds == 30
    assert loaded.ws_enabled is True
    assert loaded.ws_url == "wss://example/ws"


def test_corrupt_file_falls_back_to_defaults(tmp_path):
    path = tmp_path / "runtime.json"
    path.write_text("{not valid json", encoding="utf-8")
    cfg = AgentConfig.load(path)
    assert cfg.scan_interval_seconds == 60


def test_unknown_keys_in_file_are_ignored(tmp_path):
    path = tmp_path / "runtime.json"
    path.write_text('{"scan_interval_seconds": 45, "made_up_field": 1}', encoding="utf-8")
    cfg = AgentConfig.load(path)
    assert cfg.scan_interval_seconds == 45


def test_env_override_wins_over_file(tmp_path, monkeypatch):
    path = tmp_path / "runtime.json"
    AgentConfig(scan_interval_seconds=30).save(path)
    monkeypatch.setenv("CLAUDEFLEET_SCAN_INTERVAL", "15")
    cfg = AgentConfig.load(path)
    assert cfg.scan_interval_seconds == 15


def test_malformed_env_override_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDEFLEET_SCAN_INTERVAL", "not-a-number")
    cfg = AgentConfig.load(tmp_path / "missing.json")
    assert cfg.scan_interval_seconds == 60


def test_validated_clamps_out_of_range_values():
    cfg = AgentConfig(scan_interval_seconds=1, retry_max_attempts=999, log_level="bogus")
    cfg.validated()
    assert cfg.scan_interval_seconds == 5
    assert cfg.retry_max_attempts == 50
    assert cfg.log_level == "INFO"
