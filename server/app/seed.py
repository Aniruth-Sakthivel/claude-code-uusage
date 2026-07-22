"""Idempotent seed: ensures the four roles exist.

The first admin **user** is not seeded — it is created from the UI on first run
via ``POST /api/v1/auth/register``, which is open only while there are zero
users. After that, all users are created by an admin.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .core.rbac import ROLE_DESCRIPTIONS, ROLES
from .models import Role


def seed(db: Session) -> None:
    existing = {r.name for r in db.execute(select(Role)).scalars().all()}
    for name in ROLES:
        if name not in existing:
            db.add(Role(name=name, description=ROLE_DESCRIPTIONS[name]))
    db.commit()
