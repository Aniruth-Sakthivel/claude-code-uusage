"""Idempotent seed: ensures the four roles exist.

The first admin **user** is not seeded — it is created from the UI on first run
via ``POST /api/v1/auth/register``, which is open only while there are zero
users. After that, all users are created by an admin.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .core import security
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
    user = User(
        email=settings.bootstrap_admin_email,
        full_name=settings.bootstrap_admin_full_name or "Administrator",
        hashed_password=security.hash_password(settings.bootstrap_admin_password),
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
