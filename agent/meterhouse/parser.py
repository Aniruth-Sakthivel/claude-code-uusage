"""Parse Claude Code JSONL transcript records into usage events.

Pure, I/O-free logic (easy to unit-test). The caller feeds an iterable of raw
lines or already-decoded records; we return deduplicated events plus session
metadata. Event identity is machine-namespaced here so it is globally unique
across the fleet from the moment it is created.

Format reference: docs/UPSTREAM_AUDIT.md (independently observed from real
Claude Code transcripts).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone

# Record types that carry information we care about.
_RELEVANT_TYPES = ("assistant", "user", "custom-title", "ai-title")

# Model family ranking: higher = more capable. Used to pick a session's
# headline model when turns mix models (e.g. a subagent uses a cheaper one).
MODEL_PRIORITY = {"fable": 5, "mythos": 5, "opus": 3, "sonnet": 2, "haiku": 1}


def model_family(model: str | None) -> str:
    """Coarse family label for a raw model id ('' -> 'unknown')."""
    if not model:
        return "unknown"
    m = model.lower()
    for fam in ("fable", "mythos", "opus", "sonnet", "haiku"):
        if fam in m:
            return fam
    return "other"


def model_priority(model: str | None) -> int:
    if not model:
        return 0
    m = model.lower()
    for keyword, prio in MODEL_PRIORITY.items():
        if keyword in m:
            return prio
    return 0


def project_name_from_cwd(cwd: str | None) -> str:
    """Friendly project label = last two path components of the cwd."""
    if not cwd:
        return "unknown"
    parts = cwd.replace("\\", "/").rstrip("/").split("/")
    parts = [p for p in parts if p]
    if len(parts) >= 2:
        return "/".join(parts[-2:])
    return parts[-1] if parts else "unknown"


def to_utc_iso(ts: str | None) -> str:
    """Normalize a transcript timestamp to a UTC ISO-8601 string.

    Claude Code writes ISO timestamps, usually with a trailing 'Z'. We store UTC
    internally and derive local time only for display. If parsing fails we keep
    the raw string so nothing is silently dropped.
    """
    if not ts:
        return ""
    raw = ts.strip()
    candidate = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return raw
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def day_of(ts_utc: str) -> str:
    """YYYY-MM-DD bucket from a UTC ISO string (empty stays empty)."""
    return ts_utc[:10] if ts_utc else ""


def is_subagent_record(record: dict, source_path: str = "") -> bool:
    """True if the record belongs to a dispatched subagent (Task/Agent tool)."""
    if record.get("isSidechain"):
        return True
    if record.get("agentId"):
        return True
    data = record.get("data")
    if isinstance(data, dict) and data.get("agentId"):
        return True
    return "/subagents/" in str(source_path).replace("\\", "/").lower()


def record_agent_id(record: dict) -> str | None:
    agent_id = record.get("agentId")
    if not agent_id:
        data = record.get("data")
        if isinstance(data, dict):
            agent_id = data.get("agentId")
    return agent_id


def make_event_id(system_id: str, message_id: str | None, *,
                  session_id: str, ts_utc: str, tool_name: str | None,
                  tokens: tuple[int, int, int, int]) -> str:
    """Deterministic, globally-unique id for a usage event.

    - With a message id (the ~99% case) the id is stable and machine-namespaced,
      so re-scanning or re-syncing the same record can never double-count.
    - Without one, we hash the immutable fields of the turn so the id is still
      deterministic across re-scans.
    """
    if message_id:
        return f"{system_id}:{message_id}"
    basis = "|".join([
        session_id or "", ts_utc or "", tool_name or "",
        *(str(t) for t in tokens),
    ])
    digest = hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]
    return f"{system_id}:syn:{digest}"


@dataclass
class ParseResult:
    events: list[dict] = field(default_factory=list)
    sessions: dict[str, dict] = field(default_factory=dict)  # session_id -> meta
    # Human prompts, as (prompt_id, session_id, day). Keyed by the record's own
    # uuid so re-reading a grown file cannot double-count. Kept separate from
    # `events` on purpose: a prompt carries no tokens, and folding it into the
    # event stream would inflate event and session counts everywhere.
    prompts: list[tuple[str, str, str]] = field(default_factory=list)
    line_count: int = 0


def _blank_session(session_id: str) -> dict:
    return {
        "session_id": session_id,
        "project_name": "unknown",
        "first_ts": "",
        "last_ts": "",
        "git_branch": "",
        "model": None,
        "topic": None,
    }


def is_human_prompt(record: dict) -> bool:
    """True for a turn a person actually typed.

    Records of type ``user`` are mostly *not* human input — the great majority
    are tool results being fed back to the model, plus a few internal meta
    records. Measured on a real transcript: 206 ``user`` records, of which only
    10 were genuine prompts. Counting the type alone overstates by ~20x.

    A record counts when it is neither meta nor a tool-result carrier.
    """
    if record.get("type") != "user":
        return False
    if record.get("isMeta"):
        return False
    content = (record.get("message") or {}).get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_result":
                return False
    return True


def _extract_title(record: dict) -> str | None:
    rtype = record.get("type")
    if rtype == "custom-title":
        return record.get("customTitle")
    if rtype == "ai-title":
        return record.get("aiTitle")
    return None


def parse_records(records, *, system_id: str, source_file: str = "",
                  start_line: int = 0) -> ParseResult:
    """Parse decoded records into deduplicated events + session metadata.

    ``records`` is any iterable of dicts. ``start_line`` lets the incremental
    scanner skip already-processed lines when it re-reads a grown file.
    Streaming records that share a ``message.id`` collapse to one event (the
    last one wins — it carries the final usage tallies).
    """
    result = ParseResult()
    seen: dict[str, dict] = {}   # message_id -> event (dedup streaming)
    no_id: list[dict] = []       # events without a message id

    for idx, record in enumerate(records, 1):
        result.line_count = idx
        if idx <= start_line:
            continue
        if not isinstance(record, dict):
            continue

        rtype = record.get("type")
        if rtype not in _RELEVANT_TYPES:
            continue
        session_id = record.get("sessionId")
        if not session_id:
            continue

        meta = result.sessions.setdefault(session_id, _blank_session(session_id))

        # Title records carry no usage; they only set the session topic.
        title = _extract_title(record)
        if title:
            if rtype == "custom-title":
                meta["topic"] = title
            elif rtype == "ai-title" and not meta.get("topic"):
                meta["topic"] = title
            continue

        ts_utc = to_utc_iso(record.get("timestamp"))
        cwd = record.get("cwd", "")
        git_branch = record.get("gitBranch", "")

        if meta["project_name"] == "unknown" and cwd:
            meta["project_name"] = project_name_from_cwd(cwd)
        if ts_utc and (not meta["first_ts"] or ts_utc < meta["first_ts"]):
            meta["first_ts"] = ts_utc
        if ts_utc and (not meta["last_ts"] or ts_utc > meta["last_ts"]):
            meta["last_ts"] = ts_utc
        if git_branch and not meta["git_branch"]:
            meta["git_branch"] = git_branch

        if rtype != "assistant":
            # Human prompts are counted here, before the assistant-only gate.
            # A record without its own uuid can't be deduplicated safely, so
            # it is skipped rather than risk inflating the count on re-scan.
            if is_human_prompt(record):
                prompt_id = record.get("uuid")
                if prompt_id and ts_utc:
                    result.prompts.append((str(prompt_id), session_id, day_of(ts_utc)))
            continue

        msg = record.get("message", {}) or {}
        usage = msg.get("usage", {}) or {}
        model = msg.get("model", "") or ""
        message_id = msg.get("id", "") or ""

        inp = int(usage.get("input_tokens", 0) or 0)
        out = int(usage.get("output_tokens", 0) or 0)
        cr = int(usage.get("cache_read_input_tokens", 0) or 0)
        cc = int(usage.get("cache_creation_input_tokens", 0) or 0)
        if inp + out + cr + cc == 0:
            continue  # nothing billable to record

        tool_name = None
        for item in msg.get("content", []) or []:
            if isinstance(item, dict) and item.get("type") == "tool_use":
                tool_name = item.get("name")
                break

        if model:
            meta["model"] = model

        event = {
            "event_id": make_event_id(
                system_id, message_id,
                session_id=session_id, ts_utc=ts_utc, tool_name=tool_name,
                tokens=(inp, out, cr, cc),
            ),
            "system_id": system_id,
            "session_id": session_id,
            "project_name": meta["project_name"],
            "ts_utc": ts_utc,
            "day": day_of(ts_utc),
            "model": model,
            "model_family": model_family(model),
            "input_tokens": inp,
            "output_tokens": out,
            "cache_read_tokens": cr,
            "cache_creation_tokens": cc,
            "total_tokens": inp + out + cr + cc,
            "tool_name": tool_name,
            "is_subagent": 1 if is_subagent_record(record, source_file) else 0,
            "agent_id": record_agent_id(record),
            "source_file": source_file,
        }

        if message_id:
            seen[message_id] = event
        else:
            no_id.append(event)

    result.events = no_id + list(seen.values())
    return result


def parse_lines(lines, *, system_id: str, source_file: str = "",
                start_line: int = 0) -> ParseResult:
    """Like :func:`parse_records` but takes raw text lines and JSON-decodes them.

    Malformed JSON lines are skipped (never abort the scan). ``line_count`` still
    counts every line read so the incremental watermark stays accurate.
    """
    def _decode(raw_lines):
        for line in raw_lines:
            line = line.strip()
            if not line:
                yield {}          # keep line numbering aligned; ignored downstream
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                yield {}          # skip malformed but still advance the counter
    return parse_records(_decode(lines), system_id=system_id,
                         source_file=source_file, start_line=start_line)
