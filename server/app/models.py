"""SQLAlchemy 2.0 ORM models — the central data model.

Two independent auth principals live here:
  * ``User``   — a human who logs into the dashboard (JWT).
  * ``ApiKey`` — a per-PC agent credential (bearer key).

RBAC: a user has exactly one ``Role``; developers are additionally scoped to a
set of ``System`` rows via ``user_systems``.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Integer, String, Table, Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# Developer → System assignments (many-to-many scoping table).
user_systems = Table(
    "user_systems",
    Base.metadata,
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("system_id", ForeignKey("systems.system_id", ondelete="CASCADE"),
           primary_key=True),
)


class Role(Base):
    __tablename__ = "roles"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(32), unique=True)  # admin/manager/developer/viewer
    description: Mapped[str] = mapped_column(String(200), default="")
    users: Mapped[list["User"]] = relationship(back_populates="role")


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120), default="")
    supabase_user_id: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    role: Mapped[Role] = relationship(back_populates="users", lazy="joined")
    systems: Mapped[list["System"]] = relationship(
        secondary=user_systems, back_populates="developers")


class System(Base):
    __tablename__ = "systems"
    system_id: Mapped[str] = mapped_column(String(64), primary_key=True)  # UUID
    display_name: Mapped[str] = mapped_column(String(120))
    hostname: Mapped[str] = mapped_column(String(255), default="")
    agent_version: Mapped[str] = mapped_column(String(32), default="")
    # Descriptive info set by an admin at enrollment.
    owner: Mapped[str] = mapped_column(String(120), default="")
    location: Mapped[str] = mapped_column(String(120), default="")
    environment: Mapped[str] = mapped_column(String(40), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    developers: Mapped[list[User]] = relationship(
        secondary=user_systems, back_populates="systems")
    api_keys: Mapped[list["ApiKey"]] = relationship(
        back_populates="system", cascade="all, delete-orphan")


class ApiKey(Base):
    __tablename__ = "api_keys"
    id: Mapped[int] = mapped_column(primary_key=True)
    system_id: Mapped[str] = mapped_column(
        ForeignKey("systems.system_id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    prefix: Mapped[str] = mapped_column(String(16), index=True)   # shown in UI
    key_hash: Mapped[str] = mapped_column(String(128))            # sha256 of full key
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    system: Mapped[System] = relationship(back_populates="api_keys")

    @property
    def active(self) -> bool:
        return self.revoked_at is None


class UsageEvent(Base):
    __tablename__ = "usage_events"
    # event_id = "<system_id>:<suffix>" — globally unique, so INSERT is idempotent.
    event_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    system_id: Mapped[str] = mapped_column(
        ForeignKey("systems.system_id", ondelete="CASCADE"), index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    project_name: Mapped[str] = mapped_column(String(255), default="unknown", index=True)
    ts_utc: Mapped[str] = mapped_column(String(40))
    day: Mapped[str] = mapped_column(String(10), index=True)
    model: Mapped[str] = mapped_column(String(80), default="")
    model_family: Mapped[str] = mapped_column(String(24), default="unknown", index=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_creation_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0, index=True)
    tool_name: Mapped[str | None] = mapped_column(String(80))
    is_subagent: Mapped[int] = mapped_column(Integer, default=0)
    agent_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SyncLog(Base):
    __tablename__ = "sync_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    system_id: Mapped[str] = mapped_column(String(64), index=True)
    received: Mapped[int] = mapped_column(Integer, default=0)
    inserted: Mapped[int] = mapped_column(Integer, default=0)
    duplicates: Mapped[int] = mapped_column(Integer, default=0)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    actor_user_id: Mapped[int | None] = mapped_column(Integer)
    actor_email: Mapped[str] = mapped_column(String(255), default="")
    action: Mapped[str] = mapped_column(String(64), index=True)
    target: Mapped[str] = mapped_column(String(255), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
