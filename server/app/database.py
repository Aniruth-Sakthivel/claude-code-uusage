"""Database engine, session factory, and declarative base.

SQLite for dev (with the check_same_thread tweak FastAPI needs); swap
``CLAUDEFLEET_DATABASE_URL`` for Postgres in production — nothing else changes.
Schema is created via Alembic in production; for dev bootstrap we call
``Base.metadata.create_all`` on startup (see main.py).
"""

from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings

settings = get_settings()

_url = make_url(settings.database_url)
if _url.drivername == "postgresql":
    _url = _url.set(drivername="postgresql+psycopg")  # use psycopg 3, not psycopg2

_connect_args = {"check_same_thread": False} if _url.drivername.startswith("sqlite") else {}
engine = create_engine(_url, connect_args=_connect_args, future=True)
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
