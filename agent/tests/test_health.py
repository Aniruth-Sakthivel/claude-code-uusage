from meterhouse.health import HealthState


def test_record_scan_success_and_failure(tmp_path):
    state = HealthState()
    state.record_scan(duration_ms=12.5)
    assert state.scans_completed == 1
    assert state.scans_failed == 0
    assert state.last_scan_error is None

    state.record_scan(duration_ms=5.0, error="boom")
    assert state.scans_failed == 1
    assert state.last_scan_error == "boom"


def test_ws_connect_disconnect_resets_reconnect_counter():
    state = HealthState()
    state.record_ws_reconnect_attempt()
    state.record_ws_reconnect_attempt()
    assert state.ws_reconnect_attempts == 2

    state.record_ws_connected()
    assert state.ws_connected is True
    assert state.ws_reconnect_attempts == 0

    state.record_ws_disconnected("ConnectionClosed: 1006")
    assert state.ws_connected is False
    assert state.ws_last_disconnect_reason == "ConnectionClosed: 1006"


def test_save_and_load_round_trip(tmp_path):
    path = tmp_path / "health.json"
    state = HealthState()
    state.record_scan(duration_ms=42.0)
    state.save(path)

    loaded = HealthState.load(path)
    assert loaded is not None
    assert loaded.scans_completed == 1
    assert loaded.last_scan_duration_ms == 42.0


def test_load_missing_file_returns_none(tmp_path):
    assert HealthState.load(tmp_path / "missing.json") is None


def test_load_corrupt_file_returns_none(tmp_path):
    path = tmp_path / "health.json"
    path.write_text("not json", encoding="utf-8")
    assert HealthState.load(path) is None
