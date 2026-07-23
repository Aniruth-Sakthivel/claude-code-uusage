"""Application configuration (12-factor: everything overridable via env)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CLAUDEFLEET_", env_file=".env")

    # Storage — SQLite by default; point at Postgres in production.
    database_url: str = "sqlite:///./claudefleet.db"

    # Auth
    jwt_secret: str = "dev-insecure-change-me"      # MUST be overridden in prod
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 720          # 12h

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
