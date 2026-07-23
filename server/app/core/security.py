"""Supabase-session verification and agent API-key generation.

Agent keys are random tokens; only their sha256 hash is stored, so a leaked
DB never reveals a key.
"""

from __future__ import annotations

import hashlib
import secrets

import jwt

from ..config import get_settings

settings = get_settings()


# ── JWT ──────────────────────────────────────────────────────────────────────
# User sessions are issued and signed by Supabase Auth; the server only
# verifies them here. Agent API keys (below) remain a fully separate,
# app-issued credential.
def decode_supabase_token(token: str) -> dict:
    return jwt.decode(
        token, settings.supabase_jwt_secret, algorithms=["HS256"],
        audience="authenticated")


# ── agent API keys ─────────────────────────────────────────────────────────────
def generate_api_key() -> tuple[str, str, str]:
    """Return (full_key, prefix, sha256_hash). Full key is shown to the admin once."""
    secret = secrets.token_urlsafe(32)
    full = f"cfk_{secret}"
    return full, full[:12], hash_api_key(full)


def hash_api_key(full_key: str) -> str:
    return hashlib.sha256(full_key.encode()).hexdigest()
