"""Service layer: business logic and orchestration.

Routers call services; services use repositories + models. Cross-cutting concerns
(audit logging, dashboard shaping, sync accounting) live here, not in handlers.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import repositories as repo
from .core import security, supabase_admin
from .core.rbac import ROLE_DESCRIPTIONS, ROLES, visible_system_ids
from .models import ApiKey, AuditLog, Role, SyncLog, System, User, utcnow


# ── audit ─────────────────────────────────────────────────────────────────────
def audit(db: Session, actor: User | None, action: str, target: str = "", detail: str = ""):
    db.add(AuditLog(
        actor_user_id=actor.id if actor else None,
        actor_email=actor.email if actor else "system",
        action=action, target=target, detail=detail))
    db.flush()


# ── dashboard shaping ────────────────────────────────────────────────────────────
def _month_start() -> str:
    return date.today().replace(day=1).isoformat()


def _week_start() -> str:
    return (date.today() - timedelta(days=6)).isoformat()


def build_summary(db: Session, user: User) -> dict:
    allowed = visible_system_ids(user)
    systems = repo.list_systems(db, allowed)
    totals = repo.totals_by_system(db, allowed)
    ranking = _ranking(systems, totals)
    active = sum(1 for s in systems if repo.is_online(s))
    return {
        "today_tokens": repo.sum_tokens(db, allowed, date.today().isoformat()),
        "week_tokens": repo.sum_tokens(db, allowed, _week_start()),
        "month_tokens": repo.sum_tokens(db, allowed, _month_start()),
        "total_tokens": repo.sum_tokens(db, allowed),
        "active_systems": active,
        "total_systems": len(systems),
        "highest": ranking[0] if ranking else None,
    }


def _ranking(systems: list[System], totals: dict[str, int]) -> list[dict]:
    grand = sum(totals.get(s.system_id, 0) for s in systems) or 1
    items = [{
        "system_id": s.system_id,
        "display_name": s.display_name,
        "total_tokens": totals.get(s.system_id, 0),
        "pct": round(totals.get(s.system_id, 0) / grand * 100, 1),
    } for s in systems]
    items.sort(key=lambda x: x["total_tokens"], reverse=True)
    return items


def build_ranking(db: Session, user: User, since_day: str | None) -> list[dict]:
    allowed = visible_system_ids(user)
    systems = repo.list_systems(db, allowed)
    totals = repo.totals_by_system(db, allowed, since_day)
    return _ranking(systems, totals)


def build_timeseries(db: Session, user: User, days: int) -> dict:
    allowed = visible_system_ids(user)
    systems = repo.list_systems(db, allowed)
    totals = repo.totals_by_system(db, allowed,
                                   (date.today() - timedelta(days=days - 1)).isoformat())
    rows = repo.timeseries(db, allowed, days)
    day_list = [(date.today() - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]
    by_day: dict[str, dict[str, int]] = {d: {} for d in day_list}
    for d, sid, tok in rows:
        by_day.setdefault(d, {})[sid] = tok
    return {
        "days": day_list,
        "systems": _ranking(systems, totals),
        "points": [{"day": d, "values": by_day.get(d, {})} for d in day_list],
    }


def decorate_systems(db: Session, user: User) -> list[dict]:
    allowed = visible_system_ids(user)
    systems = repo.list_systems(db, allowed)
    stats = repo.system_stats(db, allowed)
    out = []
    for s in systems:
        st = stats.get(s.system_id, {})
        out.append({
            "system_id": s.system_id, "display_name": s.display_name,
            "hostname": s.hostname, "agent_version": s.agent_version,
            "owner": s.owner, "location": s.location,
            "environment": s.environment, "notes": s.notes,
            "last_seen_at": s.last_seen_at, "created_at": s.created_at,
            "status": "online" if repo.is_online(s) else "offline",
            "total_tokens": st.get("total_tokens", 0),
            "sessions": st.get("sessions", 0), "projects": st.get("projects", 0),
        })
    return out


# ── agent sync ────────────────────────────────────────────────────────────────
def ingest_usage(db: Session, system: System, events: list) -> dict:
    inserted, duplicates = repo.insert_events(db, system.system_id, events)
    db.add(SyncLog(system_id=system.system_id, received=len(events),
                   inserted=inserted, duplicates=duplicates))
    system.last_seen_at = datetime.now(timezone.utc)
    db.commit()
    return {"received": len(events), "inserted": inserted,
            "duplicates": duplicates, "failed": 0}


def register_agent(db: Session, system: System, display_name: str | None,
                   hostname: str | None, agent_version: str | None) -> System:
    if display_name:
        system.display_name = display_name
    if hostname:
        system.hostname = hostname
    if agent_version:
        system.agent_version = agent_version
    system.last_seen_at = datetime.now(timezone.utc)
    db.commit()
    return system


def heartbeat(db: Session, system: System) -> None:
    system.last_seen_at = datetime.now(timezone.utc)
    db.commit()


# ── systems + keys admin ────────────────────────────────────────────────────────
def create_system(db: Session, actor: User, data) -> tuple[System, str]:
    system = System(
        system_id=str(uuid.uuid4()), display_name=data.display_name,
        owner=data.owner, location=data.location,
        environment=data.environment, notes=data.notes)
    db.add(system)
    db.flush()
    full_key, key = _issue_key(db, system, name="default")
    audit(db, actor, "system.created", system.system_id,
          f"{data.display_name} owner={data.owner or '-'} loc={data.location or '-'}")
    db.commit()
    return system, full_key


def _issue_key(db: Session, system: System, name: str) -> tuple[str, ApiKey]:
    full_key, prefix, key_hash = security.generate_api_key()
    key = ApiKey(system_id=system.system_id, name=name, prefix=prefix, key_hash=key_hash)
    db.add(key)
    db.flush()
    return full_key, key


def create_api_key(db: Session, actor: User, system_id: str, name: str) -> tuple[ApiKey, str]:
    system = _require_system(db, system_id)
    full_key, key = _issue_key(db, system, name or "key")
    audit(db, actor, "apikey.created", system_id, f"prefix={key.prefix}")
    db.commit()
    return key, full_key


def rotate_api_key(db: Session, actor: User, key_id: int) -> tuple[ApiKey, str]:
    old = db.get(ApiKey, key_id)
    if old is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "API key not found")
    old.revoked_at = utcnow()
    system = _require_system(db, old.system_id)
    full_key, key = _issue_key(db, system, old.name)
    audit(db, actor, "apikey.rotated", old.system_id, f"old={old.prefix} new={key.prefix}")
    db.commit()
    return key, full_key


def revoke_api_key(db: Session, actor: User, key_id: int) -> None:
    key = db.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "API key not found")
    key.revoked_at = utcnow()
    audit(db, actor, "apikey.revoked", key.system_id, f"prefix={key.prefix}")
    db.commit()


def list_api_keys(db: Session, system_id: str) -> list[ApiKey]:
    return list(db.execute(
        select(ApiKey).where(ApiKey.system_id == system_id)
        .order_by(ApiKey.created_at.desc())).scalars().all())


# ── users admin ───────────────────────────────────────────────────────────────
def _require_role(db: Session, name: str) -> Role:
    role = db.execute(select(Role).where(Role.name == name)).scalar_one_or_none()
    if role is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unknown role '{name}'. Valid: {', '.join(ROLES)}")
    return role


def _require_system(db: Session, system_id: str) -> System:
    system = db.get(System, system_id)
    if system is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "System not found")
    return system


def _assign_systems(db: Session, user: User, system_ids: list[str]) -> None:
    user.systems = [_require_system(db, sid) for sid in system_ids]


def create_user(db: Session, actor: User, data) -> User:
    if db.execute(select(User).where(User.email == data.email)).scalar_one_or_none():
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    supabase_user_id = supabase_admin.create_auth_user(data.email, data.password)
    user = User(email=data.email, full_name=data.full_name,
                supabase_user_id=supabase_user_id,
                role_id=_require_role(db, data.role).id)
    db.add(user)
    db.flush()
    _assign_systems(db, user, data.system_ids)
    audit(db, actor, "user.created", data.email, f"role={data.role}")
    db.commit()
    return user


def update_user(db: Session, actor: User, user_id: int, data) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if data.full_name is not None:
        user.full_name = data.full_name
    if data.password is not None:
        if user.supabase_user_id:
            supabase_admin.update_auth_user_password(user.supabase_user_id, data.password)
    if data.role is not None:
        user.role_id = _require_role(db, data.role).id
    if data.is_active is not None:
        user.is_active = data.is_active
    if data.system_ids is not None:
        _assign_systems(db, user, data.system_ids)
    audit(db, actor, "user.updated", user.email, "")
    db.commit()
    return user


def delete_user(db: Session, actor: User, user_id: int) -> None:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    if user.id == actor.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "You cannot delete yourself")
    if user.supabase_user_id:
        supabase_admin.delete_auth_user(user.supabase_user_id)
    audit(db, actor, "user.deleted", user.email, "")
    db.delete(user)
    db.commit()


def list_users(db: Session) -> list[User]:
    return list(db.execute(select(User).order_by(User.email)).scalars().all())


def user_out(user: User) -> dict:
    return {
        "id": user.id, "email": user.email, "full_name": user.full_name,
        "role": user.role.name, "is_active": user.is_active,
        "system_ids": [s.system_id for s in user.systems],
    }


def list_roles(db: Session) -> list[dict]:
    return [{"name": n, "description": ROLE_DESCRIPTIONS[n]} for n in ROLES]


def list_audit(db: Session, limit: int = 200) -> list[AuditLog]:
    return list(db.execute(
        select(AuditLog).order_by(AuditLog.at.desc()).limit(limit)).scalars().all())


# ── auth ──────────────────────────────────────────────────────────────────────
# Supabase Auth owns credentials; the app DB only needs a local User row per
# Supabase identity to carry role + system-scoping (RBAC). "Registration" here
# means provisioning that local row the first time a Supabase user is seen.
def registration_open(db: Session) -> bool:
    """First-run: the initial Supabase user to appear becomes admin."""
    return db.execute(select(User)).first() is None


def provision_user(db: Session, supabase_user_id: str, email: str,
                   full_name: str = "") -> User:
    """Ensure a local User row exists for this Supabase identity.

    The first user ever provisioned becomes admin (first-run bootstrap);
    everyone after that is created by an admin via /admin/users, so a
    Supabase-authenticated user with no local row here has no account yet.
    """
    user = db.execute(
        select(User).where(User.supabase_user_id == supabase_user_id)
    ).scalar_one_or_none()
    if user is not None:
        return user

    if not registration_open(db):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "No account for this login. Ask an administrator to create your account.")

    admin_role = _require_role(db, "admin")
    user = User(email=email, full_name=full_name or "Administrator",
                supabase_user_id=supabase_user_id, role_id=admin_role.id)
    db.add(user)
    db.flush()
    audit(db, user, "auth.register_admin", email, "initial administrator")
    db.commit()
    return user
