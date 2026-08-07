"""Central-mode sync client.

Pushes locally-stored usage events to the Meterhouse central API. Uses only the
standard library (``urllib``) so the agent needs no extra dependency even in
central mode. Designed to be safe offline: network failures raise
:class:`SyncError` and leave the local ``synced`` flags untouched, so the next
run simply retries the same events. Because event ids are deterministic and the
server dedups, retrying can never double-count.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass


class SyncError(Exception):
    """Raised when the server is unreachable or returns a non-2xx status."""


_SECURE_SCHEMES = {"https", "wss"}


def warn_if_insecure(url: str) -> str | None:
    """Return a warning string if ``url`` would send the API key in
    cleartext, else None. Covers both the REST server URL (http/https) and
    the WebSocket push URL (ws/wss) — both carry the same Bearer api_key.
    Loopback URLs are exempt — local dev has no network path to sniff.
    """
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme in _SECURE_SCHEMES:
        return None
    if parsed.hostname in ("localhost", "127.0.0.1", "::1"):
        return None
    secure_scheme = "wss" if parsed.scheme == "ws" else "https"
    return (
        f"WARNING: '{url}' is not encrypted — the API key will be sent in "
        f"cleartext. Use a {secure_scheme}:// URL in production."
    )


def _suffix(event_id: str) -> str:
    # local event_id is "<local_system_id>:<suffix>"; the server prepends its own
    # system_id (resolved from the API key), so we send only the suffix.
    return event_id.split(":", 1)[1] if ":" in event_id else event_id


def row_to_event(row) -> dict:
    return {
        "suffix": _suffix(row["event_id"]),
        "session_id": row["session_id"],
        "project_name": row["project_name"],
        "ts_utc": row["ts_utc"],
        "day": row["day"],
        "model": row["model"] or "",
        "model_family": row["model_family"] or "unknown",
        "input_tokens": row["input_tokens"],
        "output_tokens": row["output_tokens"],
        "cache_read_tokens": row["cache_read_tokens"],
        "cache_creation_tokens": row["cache_creation_tokens"],
        "total_tokens": row["total_tokens"],
        "tool_name": row["tool_name"],
        "is_subagent": row["is_subagent"],
        "agent_id": row["agent_id"],
    }


@dataclass
class SyncClient:
    server_url: str
    api_key: str
    timeout: float = 15.0

    def _post(self, path: str, payload: dict) -> dict:
        url = self.server_url.rstrip("/") + path
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            raise SyncError(f"server returned {e.code}: {e.read().decode('utf-8', 'replace')}")
        except urllib.error.URLError as e:
            raise SyncError(f"cannot reach {url}: {e.reason}")

    def register(self, display_name: str, hostname: str, agent_version: str) -> dict:
        return self._post("/api/v1/systems/register", {
            "display_name": display_name, "hostname": hostname,
            "agent_version": agent_version})

    def heartbeat(self) -> dict:
        return self._post("/api/v1/systems/heartbeat", {})

    def report_status(self, state: str, detail: str = "", *,
                      scan_interval_seconds: int | None = None,
                      last_scan_at: str | None = None,
                      last_scan_duration_ms: float | None = None,
                      active_sessions: int | None = None) -> dict:
        """Tell the dashboard what this agent is doing right now.

        Sent at each step of a cycle (scanning -> scanned -> syncing -> idle)
        so an admin can watch a machine work instead of inferring it from a
        "last seen" timestamp that looks identical whether the agent is
        scanning or wedged.

        `stopped` is the terminal state: the agent finished its work and exited
        because nobody is using Claude Code. Since the agent only runs during a
        session, that report is what stops an idle machine from decaying into
        looking stalled and then dead.
        """
        payload: dict = {"state": state, "detail": detail[:255]}
        if scan_interval_seconds is not None:
            payload["scan_interval_seconds"] = scan_interval_seconds
        if active_sessions is not None:
            payload["active_sessions"] = active_sessions
        if last_scan_at is not None:
            payload["last_scan_at"] = last_scan_at
        if last_scan_duration_ms is not None:
            payload["last_scan_duration_ms"] = last_scan_duration_ms
        return self._post("/api/v1/systems/status", payload)

    def ack_command(self, command_id: int, status: str, detail: str = "") -> dict:
        """Report the outcome of a fleet-management command back to the
        server. Until this is called the command stays 'pending' and keeps
        being handed out on every check-in (register/heartbeat/sync/ws)."""
        return self._post(
            f"/api/v1/systems/commands/{command_id}/ack",
            {"status": status, "detail": detail[:2000]},
        )

    def push(self, events: list[dict], prompts: list[dict] | None = None,
             session_titles: list[dict] | None = None) -> dict:
        payload: dict = {"events": events}
        # Both are optional and independently gated; omitted entirely rather
        # than sent empty, so an older server ignores them cleanly.
        if prompts:
            payload["prompts"] = prompts
        if session_titles:
            payload["session_titles"] = session_titles
        return self._post("/api/v1/usage/sync", payload)

    def report_health(self, health: dict) -> dict:
        """Push the full local health snapshot for the diagnostics view.

        Distinct from `report_status`: that is a curated per-transition
        subset sent often and must stay cheap; this is the complete picture
        (scan counts, WS state, offline queue depth, validation issues),
        sent rarely — a periodic health-loop tick, or on demand via the
        `health_check` command.
        """
        return self._post("/api/v1/systems/health", health)

    def report_account(self, payload: dict) -> dict:
        """Report Claude account identity + rate-limit utilization.

        Deliberately its own endpoint rather than a field on `push`: the
        cadences differ (identity changes almost never, utilization every
        scan), and a failure here must never interfere with usage sync.
        """
        return self._post("/api/v1/account/report", payload)


def sync_store(store, client: SyncClient, batch_size: int = 500,
               verbose: bool = False, send_titles: bool = False) -> dict:
    """Push all unsynced events from a local Store. Returns cumulative counts.

    Marks events synced only after the server confirms the batch, so a mid-run
    failure is fully recoverable on the next call.

    Prompt counts ride along unconditionally — a count carries no content.
    Session titles ride along only when ``send_titles`` is set, because a title
    describes what someone was working on.
    """
    totals = {"received": 0, "inserted": 0, "duplicates": 0}

    # Prompts and titles are cheap and bounded; attach them to the first batch
    # rather than opening extra round-trips.
    prompt_rows = store.unsynced_prompt_counts(limit=batch_size)
    prompts = [
        {"session_id": r["session_id"], "day": r["day"], "prompt_count": r["prompt_count"]}
        for r in prompt_rows
    ]
    title_rows = store.unsynced_titles(limit=batch_size) if send_titles else []
    titles = [{"session_id": r["session_id"], "title": r["title"]} for r in title_rows]

    while True:
        rows = store.unsynced_events(limit=batch_size)
        if not rows and not prompts and not titles:
            break

        events = [row_to_event(r) for r in rows]
        resp = client.push(events, prompts, titles)    # raises SyncError if offline
        store.mark_synced([r["event_id"] for r in rows])

        # Only clear these once the server has taken them.
        if prompts:
            store.mark_prompts_synced([(p["session_id"], p["day"]) for p in prompts])
            prompts = []
        if titles:
            store.mark_titles_synced([t["session_id"] for t in titles])
            titles = []

        for k in totals:
            totals[k] += resp.get(k, 0)
        if verbose:
            print(f"  synced {resp.get('inserted',0)} new / "
                  f"{resp.get('duplicates',0)} dup ({len(rows)} sent)")
        if len(rows) < batch_size:
            break
    return totals
