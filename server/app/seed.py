"""Idempotent seed: ensures the four roles exist.

The first admin **user** is not seeded by default — it is provisioned the
first time a Supabase-authenticated user calls ``POST /api/v1/auth/provision``
while zero users exist. After that, all users are created by an admin.
``bootstrap_admin_*`` settings are an optional alternate path to create the
first admin (and its Supabase Auth account) automatically at startup.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .core import supabase_admin
from .core.rbac import ROLE_DESCRIPTIONS, ROLES
from .models import AuditLog, Role, User

settings = get_settings()


def seed(db: Session) -> None:
    existing = {r.name for r in db.execute(select(Role)).scalars().all()}
    for name in ROLES:
        if name not in existing:
            db.add(Role(name=name, description=ROLE_DESCRIPTIONS[name]))
    db.commit()
    _bootstrap_admin(db)


def _bootstrap_admin(db: Session) -> None:
    if not settings.bootstrap_admin_email or not settings.bootstrap_admin_password:
        return
    if db.execute(select(User)).first() is not None:
        return

    admin_role = db.execute(select(Role).where(Role.name == "admin")).scalar_one()
    # Idempotent: if the local DB was reset but the Supabase Auth account
    # survived (e.g. re-seeding, test DB reset), reuse it instead of erroring.
    supabase_user_id = supabase_admin.find_auth_user_by_email(settings.bootstrap_admin_email)
    if supabase_user_id is None:
        supabase_user_id = supabase_admin.create_auth_user(
            settings.bootstrap_admin_email, settings.bootstrap_admin_password)
    user = User(
        email=settings.bootstrap_admin_email,
        full_name=settings.bootstrap_admin_full_name or "Administrator",
        supabase_user_id=supabase_user_id,
        role_id=admin_role.id,
    )
    db.add(user)
    db.flush()
    db.add(AuditLog(
        actor_user_id=user.id,
        actor_email=user.email,
        action="auth.register_admin",
        target=user.email,
        detail="bootstrapped administrator",
    ))
    db.commit()
