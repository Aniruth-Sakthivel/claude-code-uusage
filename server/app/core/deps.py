"""FastAPI dependencies: resolve the current user (JWT) or agent (API key)."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import ApiKey, System, User
from . import security
from .rbac import can

_bearer = HTTPBearer(auto_error=True)


# ── human users (JWT) ───────────────────────────────────────────────────────────
def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    invalid = HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    try:
        payload = security.decode_access_token(creds.credentials)
        user_id = int(payload["sub"])
    except Exception:
        raise invalid
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise invalid
    return user


def require(capability: str):
    """Dependency factory: 403 unless the current user has the capability."""
    def _dep(user: User = Depends(get_current_user)) -> User:
        if not can(user, capability):
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                f"Requires capability: {capability}")
        return user
    return _dep


# ── agents (API key) ─────────────────────────────────────────────────────────────
def get_current_agent(
    authorization: str = Header(...),
    db: Session = Depends(get_db),
) -> System:
    """Authenticate a PC agent by its bearer API key and return its System."""
    invalid = HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid agent API key")
    if not authorization.lower().startswith("bearer "):
        raise invalid
    full_key = authorization.split(" ", 1)[1].strip()
    key_hash = security.hash_api_key(full_key)
    row = db.execute(select(ApiKey).where(ApiKey.key_hash == key_hash)).scalar_one_or_none()
    if row is None or not row.active:
        raise invalid
    row.last_used_at = datetime.now(timezone.utc)
    system = db.get(System, row.system_id)
    if system is None:
        raise invalid
    db.commit()
    return system
