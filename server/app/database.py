"""Database engine, session factory, and declarative base.

SQLite for dev (with the check_same_thread tweak FastAPI needs); swap
``CLAUDEFLEET_DATABASE_URL`` for Postgres in production — nothing else changes.
Schema is created via Alembic in production; for dev bootstrap we call
``Base.metadata.create_all`` on startup (see main.py).
"""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

settings = get_settings()

_connect_args = (
    {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
)
engine = create_engine(settings.database_url, connect_args=_connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False,
                            expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency: one Session per request, always closed."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
