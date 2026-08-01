import os
import tempfile

from meterhouse import Agent


def test_agent_sdk_register_scan_sync(tmp_path, monkeypatch):
    # Use a temporary config/db location so this test is isolated.
    config_path = tmp_path / "agent.json"
    db_path = tmp_path / "usage.db"

    agent = Agent(config_path=str(config_path), db_path=str(db_path), display_name="sdk-test")

    assert agent.identity.display_name == "sdk-test"
    assert agent.identity.system_id
    assert str(config_path) == agent.config_path

    # Local scan should work even without central config.
    result = agent.scan(verbose=False)
    assert isinstance(result, dict)
    assert all(k in result for k in ["new", "updated", "skipped", "events_inserted"])

    # Health is available after scan even if daemon is not running.
    health = agent.health()
    assert health is None or hasattr(health, "updated_at")
