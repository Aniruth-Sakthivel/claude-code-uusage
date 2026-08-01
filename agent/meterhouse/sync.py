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
