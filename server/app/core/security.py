"""Password hashing, JWT tokens, and agent API-key generation.

Passwords use bcrypt directly (no passlib version drama). Agent keys are random
tokens; only their sha256 hash is stored, so a leaked DB never reveals a key.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from ..config import get_settings

settings = get_settings()


# ── passwords ─────────────────────────────────────────────────────────────────
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except ValueError:
        return False


# ── JWT ──────────────────────────────────────────────────────────────────────
def create_access_token(subject: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_expire_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


# ── agent API keys ─────────────────────────────────────────────────────────────
def generate_api_key() -> tuple[str, str, str]:
    """Return (full_key, prefix, sha256_hash). Full key is shown to the admin once."""
    secret = secrets.token_urlsafe(32)
    full = f"cfk_{secret}"
    return full, full[:12], hash_api_key(full)


def hash_api_key(full_key: str) -> str:
    return hashlib.sha256(full_key.encode()).hexdigest()
