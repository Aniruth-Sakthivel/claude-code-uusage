"""Claude account identity and rate-limit utilization.

This is the **only** module that opens ``~/.claude.json``, and it is off
unless an operator turns it on (``account_reporting_enabled``). Everything
else the agent reads is transcript token counts.

Why this file is treated differently from every other read in the agent:
it contains the account's identity *and*, depending on the Claude Code
version, OAuth tokens. So nothing is copied wholesale. Two hardcoded
allowlists below decide what may leave the machine, and any key not named
there is dropped — including keys that do not exist yet. The credential
store (``.credentials.json``) is never opened at all.

What this buys: the real rate-limit position (used / remaining / resets_at
for the 5-hour and 7-day windows) as Claude Code itself cached it. That is
an exact figure, unlike the token-cost estimate the rest of the agent
computes.

``tests/test_account.py`` is the guardrail — it plants credential-shaped
values in a fixture and asserts they never reach the payload.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

# Identity fields, mapped from Claude Code's camelCase to our snake_case wire
# names. Anything absent from this mapping is not transmitted.
_ALLOWED_OAUTH_FIELDS = {
    "accountUuid": "account_uuid",
    "emailAddress": "email_address",
    "displayName": "display_name",
    "organizationName": "organization_name",
    "organizationUuid": "organization_uuid",
    "organizationType": "organization_type",
    "organizationRateLimitTier": "rate_limit_tier",
    "organizationRole": "organization_role",
    "billingType": "billing_type",
    "hasExtraUsageEnabled": "has_extra_usage_enabled",
    # Billing timeline. Anthropic does not publish a next-invoice date here, so
    # the subscription start is the only anchor available for a renewal
    # estimate, and the trial end is the one genuine "pay by" date in the file.
    # All are plain timestamps/labels — no payment instrument is present in
    # ~/.claude.json at all, and none is read.
    "accountCreatedAt": "account_created_at",
    "subscriptionCreatedAt": "subscription_created_at",
    "claudeCodeTrialEndsAt": "trial_ends_at",
    "seatTier": "seat_tier",
    "userRateLimitTier": "user_rate_limit_tier",
}

# Fields taken from each entry of `utilization.limits`. That array is the
# canonical source: it carries Anthropic's own `severity` verdict, so the
# health indicator is reported rather than invented from a threshold we made
# up. Its `kind` values seen in the wild: session (the 5-hour window),
# weekly_all, weekly_scoped (per-model).
_ALLOWED_LIMIT_FIELDS = frozenset(
    {"kind", "group", "percent", "severity", "resets_at", "is_active"}
)

# Dollar figures live on the named windows and are null on subscription
# plans — they only carry a value for API / extra-usage billing. They are
# reported when present and left absent otherwise; never coerced to 0, which
# would read as "nothing used" rather than "not applicable".
_DOLLAR_WINDOWS = ("five_hour", "seven_day")
_DOLLAR_FIELDS = ("limit_dollars", "used_dollars", "remaining_dollars")

CLAUDE_JSON_ENV = "METERHOUSE_CLAUDE_JSON"


def default_claude_json_path() -> Path:
    """Location of Claude Code's config. Overridable so tests never touch $HOME."""
    override = os.environ.get(CLAUDE_JSON_ENV)
    if override:
        return Path(override)
    return Path.home() / ".claude.json"


def _extract_account(doc: dict) -> dict | None:
    raw = doc.get("oauthAccount")
    if not isinstance(raw, dict):
        return None

    account = {}
    for source, wire in _ALLOWED_OAUTH_FIELDS.items():
        value = raw.get(source)
        if wire == "has_extra_usage_enabled":
            account[wire] = bool(value)
        else:
            # Coerce to str so an unexpected type can't smuggle a structure
            # (a dict or list) through into the payload.
            account[wire] = "" if value is None else str(value)

    # Without the account UUID there is nothing to key on server-side, and a
    # partial identity is worse than none.
    if not account["account_uuid"]:
        return None
    return account


def _limit_scope_label(raw: object) -> str:
    """Flatten `scope` to a display string — `weekly_scoped` names a model."""
    if not isinstance(raw, dict):
        return ""
    model = raw.get("model")
    if isinstance(model, dict):
        return str(model.get("display_name") or "")
    return ""


def _extract_limit(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "")
    if not kind:
        return None  # nothing to key the row on

    limit = {"kind": kind, "scope_label": _limit_scope_label(raw.get("scope"))}
    for field in _ALLOWED_LIMIT_FIELDS:
        if field == "kind":
            continue
        value = raw.get(field)
        if field == "percent":
            # An integer 0-100, NOT a 0-1 fraction. Verified against real data.
            try:
                limit[field] = float(value)
            except (TypeError, ValueError):
                limit[field] = 0.0
        elif field == "is_active":
            limit[field] = bool(value)
        else:
            limit[field] = "" if value is None else str(value)
    return limit


def _extract_dollars(util: dict) -> dict:
    """Dollar figures per named window, omitted entirely when null."""
    out = {}
    for name in _DOLLAR_WINDOWS:
        raw = util.get(name)
        if not isinstance(raw, dict):
            continue
        window = {}
        for field in _DOLLAR_FIELDS:
            value = raw.get(field)
            if value is None:
                continue  # not applicable on this plan — don't fabricate a 0
            try:
                window[field] = float(value)
            except (TypeError, ValueError):
                continue
        if window:
            out[name] = window
    return out


def _extract_utilization(doc: dict) -> dict | None:
    cached = doc.get("cachedUsageUtilization")
    if not isinstance(cached, dict):
        return None
    util = cached.get("utilization")
    if not isinstance(util, dict):
        return None

    raw_limits = util.get("limits")
    limits = []
    if isinstance(raw_limits, list):
        for entry in raw_limits:
            extracted = _extract_limit(entry)
            if extracted is not None:
                limits.append(extracted)
    if not limits:
        return None

    try:
        fetched_at_ms = int(cached.get("fetchedAtMs") or 0)
    except (TypeError, ValueError):
        fetched_at_ms = 0

    return {
        "fetched_at_ms": fetched_at_ms,
        "limits": limits,
        "dollars": _extract_dollars(util),
    }


def collect_account_report(enabled: bool, path: Path | None = None) -> dict | None:
    """Build the account payload, or ``None`` when there is nothing to send.

    Returns ``None`` — never raises — when reporting is disabled, the file is
    missing or unreadable, or its shape is not what we expect. This is an
    optional extra; a scan must never fail because of it.
    """
    if not enabled:
        return None

    target = path or default_claude_json_path()
    try:
        with open(target, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(doc, dict):
        return None

    account = _extract_account(doc)
    if account is None:
        # Utilization without an account has nowhere to attach server-side.
        return None

    return {"account": account, "utilization": _extract_utilization(doc)}
