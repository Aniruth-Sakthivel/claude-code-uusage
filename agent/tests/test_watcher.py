from meterhouse.watcher import (
    validate_account_report,
    validate_scan_summary,
    validate_sync_result,
)


def test_validate_scan_summary_ok():
    assert validate_scan_summary({"new": 1, "updated": 2, "skipped": 0, "events_inserted": 5}) == []


def test_validate_scan_summary_none_is_fine():
    assert validate_scan_summary(None) == []


def test_validate_scan_summary_flags_negative_or_missing():
    issues = validate_scan_summary({"new": -1, "updated": 2, "skipped": 0, "events_inserted": "x"})
    assert any("new" in i for i in issues)
    assert any("events_inserted" in i for i in issues)


def test_validate_account_report_none_is_fine():
    assert validate_account_report(None) == []


def test_validate_account_report_missing_uuid():
    issues = validate_account_report({"account": {"account_uuid": ""}, "utilization": None})
    assert any("account_uuid" in i for i in issues)


def test_validate_account_report_missing_email():
    issues = validate_account_report(
        {"account": {"account_uuid": "abc", "email_address": ""}, "utilization": None}
    )
    assert any("email_address" in i for i in issues)


def test_validate_account_report_percent_out_of_range():
    payload = {
        "account": {"account_uuid": "abc", "email_address": "a@b.com"},
        "utilization": {"limits": [{"kind": "session", "percent": 150, "resets_at": ""}]},
    }
    issues = validate_account_report(payload)
    assert any("percent" in i for i in issues)


def test_validate_account_report_unparseable_resets_at():
    payload = {
        "account": {"account_uuid": "abc", "email_address": "a@b.com"},
        "utilization": {
            "limits": [{"kind": "session", "percent": 10, "resets_at": "not-a-date"}]
        },
    }
    issues = validate_account_report(payload)
    assert any("resets_at" in i for i in issues)


def test_validate_account_report_clean_payload():
    payload = {
        "account": {"account_uuid": "abc", "email_address": "a@b.com"},
        "utilization": {
            "limits": [
                {"kind": "session", "percent": 42.5, "resets_at": "2026-01-01T00:00:00Z"}
            ]
        },
    }
    assert validate_account_report(payload) == []


def test_validate_sync_result_ok():
    assert validate_sync_result({"received": 10, "inserted": 8, "duplicates": 2}) == []


def test_validate_sync_result_none_is_fine():
    assert validate_sync_result(None) == []


def test_validate_sync_result_flags_mismatch():
    issues = validate_sync_result({"received": 10, "inserted": 5, "duplicates": 2})
    assert len(issues) == 1
    assert "mismatch" in issues[0]
