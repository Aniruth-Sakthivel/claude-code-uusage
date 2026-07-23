"""Supabase-session verification and agent API-key generation.

Agent keys are random tokens; only their sha256 hash is stored, so a leaked
DB never reveals a key.
"""

from __future__ import annotations

import hashlib
import secrets
from functools import lru_cache

import jwt

from ..config import get_settings

settings = get_settings()


# ── JWT ──────────────────────────────────────────────────────────────────────
# User sessions are issued and signed by Supabase Auth (ES256, asymmetric —
# this project's JWT signing keys are not a shared secret). The server
# verifies them against Supabase's public JWKS endpoint. Agent API keys
# (below) remain a fully separate, app-issued credential.
@lru_cache
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")


def decode_supabase_token(token: str) -> dict:
    signing_key = _jwks_client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token, signing_key.key, algorithms=["ES256"], audience="authenticated",
        leeway=10)


# ── agent API keys ─────────────────────────────────────────────────────────────
def generate_api_key() -> tuple[str, str, str]:
    """Return (full_key, prefix, sha256_hash). Full key is shown to the admin once."""
    secret = secrets.token_urlsafe(32)
    full = f"cfk_{secret}"
    return full, full[:12], hash_api_key(full)


def hash_api_key(full_key: str) -> str:
    return hashlib.sha256(full_key.encode()).hexdigest()
