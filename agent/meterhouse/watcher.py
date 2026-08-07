"""Data-validation checks — the "is the data itself sane" half of the Watcher.

Everything else in the agent already handles *failure* (a scan that raised,
a sync that could not reach the server) via `HealthState.record_scan`/
try-except. This module handles the quieter case: a scan or sync that
completed *without error* but produced data that is missing, out of range,
or internally inconsistent — the kind of thing that would otherwise only
surface as "the dashboard numbers look wrong" days later.

Every function here returns a list of human-readable issue strings and never
raises: a broken validator must never be the reason a scan or sync fails.
Callers log non-empty results at WARNING and feed them into
`HealthState.record_validation_issue`, which is what makes them visible in
the diagnostics view (see sync.py's `report_health`).
"""

from __future__ import annotations

from datetime import datetime


def _parse_ts(value) -> bool:
    """True if `value` is empty/absent, or a string that parses as a timestamp."""
    if value in (None, ""):
        return True
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def validate_scan_summary(summary: dict | None) -> list[str]:
    """Sanity-check the dict `scanner.scan()` returns.

    A scan that completes without raising can still return a shape that is
    quietly wrong (a negative count, a missing key) if something upstream
    changes — this catches that class of bug rather than trusting the shape.
    """
    if not summary:
        return []
    issues = []
    for key in ("new", "updated", "skipped", "events_inserted"):
        value = summary.get(key)
        if not isinstance(value, int) or value < 0:
            issues.append(f"scan summary field '{key}' is not a non-negative int: {value!r}")
    return issues


def validate_account_report(payload: dict | None) -> list[str]:
    """Sanity-check the payload `account.collect_account_report()` built.

    `payload is None` (reporting disabled, or nothing readable) is not
    itself an issue — only a *malformed* payload is.
    """
    if payload is None:
        return []
    issues = []

    account = payload.get("account")
    if not isinstance(account, dict) or not account.get("account_uuid"):
        issues.append("account report missing account_uuid")
    elif not account.get("email_address"):
        issues.append("account report missing email_address")

    utilization = payload.get("utilization")
    if isinstance(utilization, dict):
        for limit in utilization.get("limits", []):
            if not isinstance(limit, dict):
                continue
            percent = limit.get("percent")
            if not isinstance(percent, (int, float)) or not (0 <= percent <= 100):
                issues.append(
                    f"account limit '{limit.get('kind', '?')}' has an out-of-range "
                    f"percent: {percent!r}"
                )
            if not _parse_ts(limit.get("resets_at")):
                issues.append(
                    f"account limit '{limit.get('kind', '?')}' has an unparseable "
                    f"resets_at: {limit.get('resets_at')!r}"
                )

    return issues


def validate_sync_result(totals: dict | None) -> list[str]:
    """Sanity-check the cumulative totals `sync.sync_store()` returns.

    `received` is what the server says it got; `inserted + duplicates`
    should always account for all of it — a mismatch means events were
    silently dropped somewhere in the round trip.
    """
    if not totals:
        return []
    received = totals.get("received", 0)
    accounted = totals.get("inserted", 0) + totals.get("duplicates", 0)
    if accounted != received:
        return [
            f"sync totals mismatch: received={received} but "
            f"inserted+duplicates={accounted}"
        ]
    return []
