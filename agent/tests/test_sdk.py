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


def test_agent_register_adopts_the_servers_system_id(tmp_path, monkeypatch):
    """Same bug, same fix as the CLI's cmd_register: the server resolves
    system_id from the API key and never trusts a client-supplied one, so it
    is the only id that exists in the dashboard's database. Every later call
    on this Agent (scan/sync/health) keys off `self.identity.system_id`."""
    import meterhouse as mh

    config_path = tmp_path / "agent.json"
    db_path = tmp_path / "usage.db"
    agent = mh.Agent(config_path=str(config_path), db_path=str(db_path), display_name="sdk-test")

    locally_invented_id = agent.identity.system_id

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def register(self, *a, **k):
            return {"system_id": "server-authoritative-id", "display_name": "sdk-test"}

    # `Agent.register` calls the module-level name `SyncClient`, imported into
    # `meterhouse/__init__.py`'s own namespace at import time — patching
    # `meterhouse.sync.SyncClient` instead would leave that binding untouched
    # and let this test make a real network connection.
    monkeypatch.setattr(mh, "SyncClient", FakeClient)

    resp = agent.register(server_url="https://central.example", api_key="cfk_test")

    assert resp["system_id"] == "server-authoritative-id"
    assert agent.identity.system_id == "server-authoritative-id"
    assert agent.identity.system_id != locally_invented_id

    # Persisted, not just held in memory — a fresh load must see it too.
    from meterhouse.identity import load_identity
    reloaded = load_identity(config_path=config_path)
    assert reloaded.system_id == "server-authoritative-id"
