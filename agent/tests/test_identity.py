from claudefleet.identity import Identity, load_identity, save_identity


def test_identity_created_and_persisted(tmp_path):
    cfg = tmp_path / "agent.json"
    ident = load_identity(config_path=cfg, display_name="PC-01")
    assert ident.display_name == "PC-01"
    assert ident.system_id
    assert cfg.exists()

    # reload -> same immutable system_id, display name preserved
    again = load_identity(config_path=cfg, display_name="ignored-now")
    assert again.system_id == ident.system_id
    assert again.display_name == "PC-01"


def test_api_key_redacted_in_public_dict(tmp_path):
    cfg = tmp_path / "agent.json"
    ident = load_identity(config_path=cfg, display_name="PC-02")
    ident.api_key = "secret-key-value"
    save_identity(ident, cfg)
    pub = ident.public_dict()
    assert pub["api_key"] == "***"
    # but the raw dataclass still holds the real key for internal use
    assert ident.api_key == "secret-key-value"
