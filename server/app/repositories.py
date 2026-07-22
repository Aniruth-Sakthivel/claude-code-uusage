"""Data-access layer: all reads/aggregations over the DB.

Every function that returns usage data accepts ``allowed`` — the set of system
ids the caller may see (``None`` = all). This is where server-side authorization
is enforced; services/routers never build a query that ignores it.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import Select, false, func, select
from sqlalchemy.orm import Session

from .models import System, UsageEvent

ONLINE_WINDOW = timedelta(minutes=10)


def _scope(stmt: Select, column, allowed: set[str] | None) -> Select:
    if allowed is None:
        return stmt
    if not allowed:
        return stmt.where(false())     # allowed is empty → no rows
    return stmt.where(column.in_(allowed))


def _today() -> str:
    return date.today().isoformat()


def is_online(system: System) -> bool:
    if system.last_seen_at is None:
        return False
    last = system.last_seen_at
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - last <= ONLINE_WINDOW


# ── systems ───────────────────────────────────────────────────────────────────
def list_systems(db: Session, allowed: set[str] | None) -> list[System]:
    stmt = _scope(select(System), System.system_id, allowed).order_by(System.display_name)
    return list(db.execute(stmt).scalars().all())


def system_stats(db: Session, allowed: set[str] | None) -> dict[str, dict]:
    """Per-system aggregates: total tokens, distinct sessions, distinct projects."""
    stmt = _scope(
        select(
            UsageEvent.system_id,
            func.coalesce(func.sum(UsageEvent.total_tokens), 0),
            func.count(func.distinct(UsageEvent.session_id)),
            func.count(func.distinct(UsageEvent.project_name)),
        ).group_by(UsageEvent.system_id),
        UsageEvent.system_id, allowed,
    )
    out: dict[str, dict] = {}
    for sid, tokens, sessions, projects in db.execute(stmt).all():
        out[sid] = {"total_tokens": int(tokens), "sessions": sessions, "projects": projects}
    return out


# ── ranking / totals ──────────────────────────────────────────────────────────
def totals_by_system(db: Session, allowed: set[str] | None,
                     since_day: str | None = None) -> dict[str, int]:
    stmt = select(UsageEvent.system_id,
                  func.coalesce(func.sum(UsageEvent.total_tokens), 0)) \
        .group_by(UsageEvent.system_id)
    stmt = _scope(stmt, UsageEvent.system_id, allowed)
    if since_day:
        stmt = stmt.where(UsageEvent.day >= since_day)
    return {sid: int(tot) for sid, tot in db.execute(stmt).all()}


def sum_tokens(db: Session, allowed: set[str] | None,
               since_day: str | None = None) -> int:
    stmt = select(func.coalesce(func.sum(UsageEvent.total_tokens), 0))
    stmt = _scope(stmt, UsageEvent.system_id, allowed)
    if since_day:
        stmt = stmt.where(UsageEvent.day >= since_day)
    return int(db.execute(stmt).scalar_one())


def timeseries(db: Session, allowed: set[str] | None, days: int) -> list[tuple[str, str, int]]:
    start = (date.today() - timedelta(days=days - 1)).isoformat()
    stmt = select(UsageEvent.day, UsageEvent.system_id,
                  func.coalesce(func.sum(UsageEvent.total_tokens), 0)) \
        .where(UsageEvent.day >= start) \
        .group_by(UsageEvent.day, UsageEvent.system_id) \
        .order_by(UsageEvent.day)
    stmt = _scope(stmt, UsageEvent.system_id, allowed)
    return [(d, s, int(t)) for d, s, t in db.execute(stmt).all()]


# ── projects / sessions ─────────────────────────────────────────────────────────
def projects(db: Session, allowed: set[str] | None) -> list[dict]:
    stmt = select(
        UsageEvent.project_name, UsageEvent.system_id,
        func.coalesce(func.sum(UsageEvent.total_tokens), 0),
        func.coalesce(func.sum(UsageEvent.input_tokens), 0),
        func.coalesce(func.sum(UsageEvent.output_tokens), 0),
        func.coalesce(func.sum(UsageEvent.cache_read_tokens), 0),
        func.coalesce(func.sum(UsageEvent.cache_creation_tokens), 0),
        func.count(func.distinct(UsageEvent.session_id)),
    ).group_by(UsageEvent.project_name, UsageEvent.system_id) \
     .order_by(func.sum(UsageEvent.total_tokens).desc())
    stmt = _scope(stmt, UsageEvent.system_id, allowed)
    rows = db.execute(stmt).all()
    return [{
        "project_name": r[0], "system_id": r[1], "total_tokens": int(r[2]),
        "input_tokens": int(r[3]), "output_tokens": int(r[4]),
        "cache_read_tokens": int(r[5]), "cache_creation_tokens": int(r[6]),
        "sessions": r[7],
    } for r in rows]


def sessions(db: Session, allowed: set[str] | None, limit: int = 200) -> list[dict]:
    stmt = select(
        UsageEvent.session_id, UsageEvent.system_id,
        func.max(UsageEvent.project_name),
        func.max(UsageEvent.model),
        func.min(UsageEvent.ts_utc), func.max(UsageEvent.ts_utc),
        func.coalesce(func.sum(UsageEvent.input_tokens), 0),
        func.coalesce(func.sum(UsageEvent.output_tokens), 0),
        func.coalesce(func.sum(UsageEvent.cache_read_tokens + UsageEvent.cache_creation_tokens), 0),
        func.coalesce(func.sum(UsageEvent.total_tokens), 0),
    ).group_by(UsageEvent.session_id, UsageEvent.system_id) \
     .order_by(func.max(UsageEvent.ts_utc).desc()).limit(limit)
    stmt = _scope(stmt, UsageEvent.system_id, allowed)
    rows = db.execute(stmt).all()
    return [{
        "session_id": r[0], "system_id": r[1], "project_name": r[2] or "unknown",
        "model": r[3] or "", "first_ts": r[4] or "", "last_ts": r[5] or "",
        "input_tokens": int(r[6]), "output_tokens": int(r[7]),
        "cache_tokens": int(r[8]), "total_tokens": int(r[9]),
    } for r in rows]


# ── usage ingest (idempotent) ────────────────────────────────────────────────────
def insert_events(db: Session, system_id: str, events: list) -> tuple[int, int]:
    """Insert events for a system. Returns (inserted, duplicates)."""
    if not events:
        return 0, 0
    existing = set(db.execute(
        select(UsageEvent.event_id).where(UsageEvent.system_id == system_id,
            UsageEvent.event_id.in_([f"{system_id}:{e.suffix}" for e in events]))
    ).scalars().all())
    inserted = 0
    for e in events:
        eid = f"{system_id}:{e.suffix}"
        if eid in existing:
            continue
        existing.add(eid)  # guard against dup suffixes within one batch
        db.add(UsageEvent(
            event_id=eid, system_id=system_id, session_id=e.session_id,
            project_name=e.project_name, ts_utc=e.ts_utc, day=e.day,
            model=e.model, model_family=e.model_family,
            input_tokens=e.input_tokens, output_tokens=e.output_tokens,
            cache_read_tokens=e.cache_read_tokens,
            cache_creation_tokens=e.cache_creation_tokens,
            total_tokens=e.total_tokens, tool_name=e.tool_name,
            is_subagent=e.is_subagent, agent_id=e.agent_id,
        ))
        inserted += 1
    db.flush()
    return inserted, len(events) - inserted
