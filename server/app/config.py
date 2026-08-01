"""Application configuration (12-factor: everything overridable via env)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="METERHOUSE_", env_file=".env")

    # Storage — SQLite by default; point at Postgres in production.
    database_url: str = "sqlite:///./meterhouse.db"

    # Supabase (Project Settings -> API). anon_key is the public/publishable
    # key (also used by the frontend); service_role_key is server-only and
    # can create/delete Auth users. JWTs are verified against Supabase's
    # public JWKS endpoint (this project signs with ES256) — no shared
    # secret needed.
    supabase_url: str | None = None
    supabase_anon_key: str | None = None
    supabase_service_role_key: str | None = None

    # Optional bootstrap admin credentials. If set and there are no users,
    # the server creates this admin automatically at startup.
    bootstrap_admin_email: str | None = None
    bootstrap_admin_password: str | None = None
    bootstrap_admin_full_name: str | None = None

    # The first admin account is created from the UI on first run (see
    # /api/v1/auth/register), which is open only while no users exist.

    # CORS — the dev frontend origin(s)
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
