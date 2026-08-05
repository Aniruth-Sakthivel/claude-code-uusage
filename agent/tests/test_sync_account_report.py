"""`meterhouse sync` must also push the Claude account report.

Reporting used to happen only inside the daemon. Anyone driving the agent by
hand — `scan` then `sync`, which is exactly what the dashboard's setup block
tells you to do — could run `meterhouse account enable`, be told reporting was
ENABLED, and then watch the Claude accounts page stay empty forever with
nothing to explain it.

The other half of the contract matters just as much: account reporting is an
optional extra, so nothing it does may ever turn a successful usage sync into a
reported failure.
"""

import pytest

from meterhouse.cli import _report_account


class Cfg:
    def __init__(self, enabled):
        self.account_reporting_enabled = enabled


class FakeClient:
    def __init__(self, raises=None):
        self.reported = []
        self._raises = raises

    def report_account(self, payload):
        if self._raises:
            raise self._raises
        self.reported.append(payload)
        return {"ok": True}


PAYLOAD = {"account": {"account_uuid": "acc-1"}, "utilization": None}


def test_reports_when_enabled(monkeypatch, capsys):
    import meterhouse.account as account

    monkeypatch.setattr(account, "collect_account_report", lambda enabled=True: PAYLOAD)
    client = FakeClient()

    _report_account(client, Cfg(True))

    assert client.reported == [PAYLOAD]
    assert "reported" in capsys.readouterr().out.lower()


def test_sends_nothing_when_disabled(monkeypatch):
    import meterhouse.account as account

    called = []
    monkeypatch.setattr(
        account, "collect_account_report", lambda enabled=True: called.append(1) or PAYLOAD
    )
    client = FakeClient()

    _report_account(client, Cfg(False))

    assert client.reported == []
    assert called == [], "must not even read ~/.claude.json when disabled"


def test_explains_when_no_account_is_found(monkeypatch, capsys):
    import meterhouse.account as account

    monkeypatch.setattr(account, "collect_account_report", lambda enabled=True: None)
    client = FakeClient()

    _report_account(client, Cfg(True))

    assert client.reported == []
    out = capsys.readouterr().out.lower()
    assert "no claude account" in out, "silence here is what made this hard to diagnose"


def test_transport_failure_never_propagates(monkeypatch, capsys):
    """A failed report must not surface as a failed sync."""
    import meterhouse.account as account
    from meterhouse.sync import SyncError

    monkeypatch.setattr(account, "collect_account_report", lambda enabled=True: PAYLOAD)
    client = FakeClient(raises=SyncError("connection refused"))

    _report_account(client, Cfg(True))  # must not raise

    assert "unaffected" in capsys.readouterr().out.lower()


def test_unexpected_error_never_propagates(monkeypatch, capsys):
    import meterhouse.account as account

    def boom(enabled=True):
        raise ValueError("malformed ~/.claude.json")

    monkeypatch.setattr(account, "collect_account_report", boom)
    client = FakeClient()

    _report_account(client, Cfg(True))  # must not raise

    assert "skipped" in capsys.readouterr().out.lower()


def test_quiet_mode_prints_nothing(monkeypatch, capsys):
    import meterhouse.account as account

    monkeypatch.setattr(account, "collect_account_report", lambda enabled=True: PAYLOAD)
    client = FakeClient()

    _report_account(client, Cfg(True), verbose=False)

    assert client.reported == [PAYLOAD]
    assert capsys.readouterr().out == ""
