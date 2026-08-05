"""Guardrails for the one file the agent reads that contains secrets.

`~/.claude.json` holds the Claude account's identity *and* — depending on the
Claude Code version — OAuth tokens and other credentials. The agent reads a
hardcoded allowlist out of it and nothing else, so a field Anthropic adds
tomorrow cannot start leaking on its own.

These tests are the guardrail for that promise. They are deliberately
paranoid: they assert on the *serialized* payload, so a secret can't hide
inside a nested structure that a key-level check would miss.
"""

import json
import os

import pytest

from meterhouse.account import collect_account_report

# Values that must never appear in anything the agent transmits. Each is
# planted somewhere in the fixture below.
SECRETS = [
    "sk-ant-oat01-SUPERSECRET",
    "refresh-tok-DO-NOT-SEND",
    "session-cookie-NOPE",
    "scope-should-not-leak",
]


def write_claude_json(tmp_path, extra=None):
    """A realistic ~/.claude.json, salted with credential-shaped fields."""
    doc = {
        # --- secret-bearing keys that really do appear in this file ---
        "oauthAccount": {
            "accountUuid": "acc-1111-2222",
            "emailAddress": "dev@example.com",
            "displayName": "Dev Example",
            "organizationName": "Example Ltd",
            "organizationUuid": "org-3333",
            "organizationType": "claude_max",
            "organizationRateLimitTier": "default_claude_max_5x",
            "organizationRole": "admin",
            "billingType": "stripe_subscription",
            "hasExtraUsageEnabled": False,
            "accountCreatedAt": "2025-11-02T09:14:00.000Z",
            "subscriptionCreatedAt": "2026-01-17T08:30:00.000Z",
            "claudeCodeTrialEndsAt": "2026-02-16T08:30:00.000Z",
            "seatTier": "max_5x",
            "userRateLimitTier": "default_claude_max_5x",
            # Not on the allowlist — must be dropped.
            "accessToken": SECRETS[0],
            "refreshToken": SECRETS[1],
            "scopes": [SECRETS[3]],
        },
        # Shape verified against a real ~/.claude.json: `percent` is 0-100,
        # dollar fields are null on subscription plans, and `limits` carries
        # Anthropic's own severity verdict.
        "cachedUsageUtilization": {
            "accountUuid": "acc-1111-2222",
            "fetchedAtMs": 1_772_000_000_000,
            "utilization": {
                "limits": [
                    {
                        "kind": "session",
                        "group": "session",
                        "percent": 6,
                        "severity": "normal",
                        "resets_at": "2026-08-01T10:10:00+00:00",
                        "scope": None,
                        "is_active": False,
                    },
                    {
                        "kind": "weekly_all",
                        "group": "weekly",
                        "percent": 38,
                        "severity": "normal",
                        "resets_at": "2026-08-04T23:00:00+00:00",
                        "scope": None,
                        "is_active": True,
                    },
                    {
                        "kind": "weekly_scoped",
                        "group": "weekly",
                        "percent": 0,
                        "severity": "normal",
                        "resets_at": None,
                        "scope": {"model": {"id": None, "display_name": "Fable"}},
                        "is_active": False,
                    },
                ],
                "five_hour": {
                    "utilization": 6,
                    "resets_at": "2026-08-01T10:10:00+00:00",
                    "limit_dollars": None,
                    "used_dollars": None,
                    "remaining_dollars": None,
                },
                "seven_day": {
                    "utilization": 38,
                    "resets_at": "2026-08-04T23:00:00+00:00",
                    "limit_dollars": None,
                    "used_dollars": None,
                    "remaining_dollars": None,
                },
                # Null windows are normal — must not crash or be reported.
                "seven_day_opus": None,
            },
        },
        # Top-level noise, including a credential.
        "sessionCookie": SECRETS[2],
        "userID": "user-abc",
        "mcpServers": {"some": {"command": "x"}},
    }
    if extra:
        doc.update(extra)
    p = tmp_path / ".claude.json"
    p.write_text(json.dumps(doc), encoding="utf-8")
    return p


def test_no_secret_ever_reaches_the_payload(tmp_path):
    """The whole point of this module. Serialize and scan for planted secrets."""
    report = collect_account_report(enabled=True, path=write_claude_json(tmp_path))
    blob = json.dumps(report)
    for secret in SECRETS:
        assert secret not in blob, f"{secret!r} leaked into the account report"


def test_only_allowlisted_identity_fields(tmp_path):
    report = collect_account_report(enabled=True, path=write_claude_json(tmp_path))
    assert set(report["account"]) == {
        "account_uuid",
        "email_address",
        "display_name",
        "organization_name",
        "organization_uuid",
        "organization_type",
        "rate_limit_tier",
        "organization_role",
        "billing_type",
        "has_extra_usage_enabled",
        "account_created_at",
        "subscription_created_at",
        "trial_ends_at",
        "seat_tier",
        "user_rate_limit_tier",
    }
    assert report["account"]["account_uuid"] == "acc-1111-2222"
    assert report["account"]["organization_type"] == "claude_max"
    assert report["account"]["rate_limit_tier"] == "default_claude_max_5x"


def test_billing_timeline_fields_are_reported(tmp_path):
    """The dashboard's renewal estimate has no other source for these."""
    report = collect_account_report(enabled=True, path=write_claude_json(tmp_path))
    acct = report["account"]
    assert acct["subscription_created_at"] == "2026-01-17T08:30:00.000Z"
    assert acct["trial_ends_at"] == "2026-02-16T08:30:00.000Z"
    assert acct["account_created_at"] == "2025-11-02T09:14:00.000Z"
    assert acct["seat_tier"] == "max_5x"


def test_missing_billing_fields_stay_empty_not_absent(tmp_path):
    """An account with no subscription must not break the payload shape."""
    doc_path = write_claude_json(tmp_path)
    import json as _json

    doc = _json.loads(doc_path.read_text(encoding="utf-8"))
    for k in ("subscriptionCreatedAt", "claudeCodeTrialEndsAt", "accountCreatedAt"):
        doc["oauthAccount"].pop(k, None)
    doc_path.write_text(_json.dumps(doc), encoding="utf-8")

    acct = collect_account_report(enabled=True, path=doc_path)["account"]
    assert acct["subscription_created_at"] == ""
    assert acct["trial_ends_at"] == ""
    assert acct["account_created_at"] == ""


def test_limits_extracted_with_severity(tmp_path):
    report = collect_account_report(enabled=True, path=write_claude_json(tmp_path))
    util = report["utilization"]
    assert util["fetched_at_ms"] == 1_772_000_000_000

    by_kind = {limit["kind"]: limit for limit in util["limits"]}
    assert set(by_kind) == {"session", "weekly_all", "weekly_scoped"}

    weekly = by_kind["weekly_all"]
    assert weekly["percent"] == 38.0  # a percentage, not a 0-1 fraction
    assert weekly["severity"] == "normal"
    assert weekly["is_active"] is True
    assert weekly["resets_at"].startswith("2026-08-04")

    # `scope` is flattened to a label rather than passed through as a nested
    # object, so an unexpected key inside it cannot ride along.
    assert by_kind["weekly_scoped"]["scope_label"] == "Fable"
    assert by_kind["session"]["scope_label"] == ""


def test_null_dollars_are_omitted_not_zeroed(tmp_path):
    """A subscription plan reports null dollars; 0.0 would read as 'unused'."""
    report = collect_account_report(enabled=True, path=write_claude_json(tmp_path))
    assert report["utilization"]["dollars"] == {}


def test_dollars_reported_when_present(tmp_path):
    """API / extra-usage accounts do carry dollar figures."""
    doc = json.loads((write_claude_json(tmp_path)).read_text(encoding="utf-8"))
    doc["cachedUsageUtilization"]["utilization"]["five_hour"].update(
        {"limit_dollars": 40.0, "used_dollars": 12.5, "remaining_dollars": 27.5}
    )
    p = tmp_path / ".claude.json"
    p.write_text(json.dumps(doc), encoding="utf-8")

    report = collect_account_report(enabled=True, path=p)
    assert report["utilization"]["dollars"]["five_hour"] == {
        "limit_dollars": 40.0,
        "used_dollars": 12.5,
        "remaining_dollars": 27.5,
    }


def test_disabled_returns_none_and_never_opens_the_file(tmp_path, monkeypatch):
    """Opt-in means opt-in: with the flag off the file is not even touched."""
    path = write_claude_json(tmp_path)
    opened = []
    real_open = open

    def spy(file, *a, **kw):
        opened.append(str(file))
        return real_open(file, *a, **kw)

    monkeypatch.setattr("builtins.open", spy)
    monkeypatch.setattr("pathlib.Path.open", lambda self, *a, **kw: spy(self, *a, **kw))

    assert collect_account_report(enabled=False, path=path) is None
    assert not any(".claude.json" in p for p in opened)


def test_credentials_file_is_never_read(tmp_path, monkeypatch):
    """The agent must never reach for the token store, even incidentally."""
    path = write_claude_json(tmp_path)
    (tmp_path / ".credentials.json").write_text('{"token": "nope"}', encoding="utf-8")

    opened = []
    real_open = open
    monkeypatch.setattr(
        "builtins.open", lambda f, *a, **kw: (opened.append(str(f)), real_open(f, *a, **kw))[1]
    )

    collect_account_report(enabled=True, path=path)
    # Compare basenames only — pytest names tmp_path after the test function,
    # so the directory itself contains the word "credentials".
    assert not any(os.path.basename(p).lower() == ".credentials.json" for p in opened)


@pytest.mark.parametrize(
    "broken",
    ["", "not json at all", "[]", '{"oauthAccount": "a string, not an object"}'],
)
def test_malformed_input_degrades_quietly(tmp_path, broken):
    """A scan must never fail because this optional extra is unreadable."""
    p = tmp_path / ".claude.json"
    p.write_text(broken, encoding="utf-8")
    report = collect_account_report(enabled=True, path=p)
    assert report is None or report.get("account") is None


def test_missing_file_returns_none(tmp_path):
    assert collect_account_report(enabled=True, path=tmp_path / "absent.json") is None


def test_account_without_uuid_is_rejected(tmp_path):
    """Without the natural key the report is useless and must not be sent."""
    p = tmp_path / ".claude.json"
    p.write_text(json.dumps({"oauthAccount": {"emailAddress": "x@y.z"}}), encoding="utf-8")
    report = collect_account_report(enabled=True, path=p)
    assert report is None or report.get("account") is None


# ── opt-in plumbing ───────────────────────────────────────────────────────────


def test_flag_defaults_to_off():
    """The privacy-sensitive read must never be on by accident."""
    from meterhouse.config import AgentConfig

    assert AgentConfig().account_reporting_enabled is False


def test_flag_env_override(monkeypatch, tmp_path):
    from meterhouse.config import AgentConfig

    cfg_path = tmp_path / "runtime.json"
    monkeypatch.setenv("METERHOUSE_ACCOUNT_REPORTING", "true")
    assert AgentConfig.load(cfg_path).account_reporting_enabled is True

    monkeypatch.setenv("METERHOUSE_ACCOUNT_REPORTING", "0")
    assert AgentConfig.load(cfg_path).account_reporting_enabled is False


def test_flag_survives_save_and_load(tmp_path):
    from meterhouse.config import AgentConfig

    cfg_path = tmp_path / "runtime.json"
    cfg = AgentConfig()
    cfg.account_reporting_enabled = True
    cfg.save(cfg_path)
    assert AgentConfig.load(cfg_path).account_reporting_enabled is True


def test_sync_client_posts_to_account_endpoint(monkeypatch):
    """Account reporting uses its own path, not the usage sync body."""
    from meterhouse.sync import SyncClient

    seen = {}
    client = SyncClient("https://example.test", "cfk_x")
    monkeypatch.setattr(
        SyncClient,
        "_post",
        lambda self, path, payload: seen.update(path=path, payload=payload) or {},
    )
    client.report_account({"account": {"account_uuid": "u"}, "utilization": None})
    assert seen["path"] == "/api/v1/account/report"
    assert seen["payload"]["account"]["account_uuid"] == "u"
