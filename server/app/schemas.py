"""Pydantic v2 request/response models (the API contract)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# Emails are plain strings: this is a self-hosted internal tool, so we accept
# internal/reserved domains (e.g. *.local) that strict RFC deliverability
# validation would reject.
EmailStr = str


# ── auth ──────────────────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class AdminRegisterRequest(BaseModel):
    """First-run registration — creates the initial admin (zero-users only)."""
    email: EmailStr
    full_name: str = ""
    password: str = Field(min_length=8)


class RegistrationStatus(BaseModel):
    open: bool


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: EmailStr
    full_name: str
    role: str
    is_active: bool
    system_ids: list[str] = []


# ── systems ───────────────────────────────────────────────────────────────────
class SystemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    system_id: str
    display_name: str
    hostname: str
    agent_version: str
    owner: str = ""
    location: str = ""
    environment: str = ""
    notes: str = ""
    last_seen_at: datetime | None
    created_at: datetime
    status: str = "unknown"          # online/offline, computed
    total_tokens: int = 0
    sessions: int = 0
    projects: int = 0


class SystemCreate(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    owner: str = ""
    location: str = ""
    environment: str = ""
    notes: str = ""


class SystemCreated(BaseModel):
    system: SystemOut
    api_key: str                     # full key — shown exactly once


# ── agent endpoints ─────────────────────────────────────────────────────────────
class RegisterRequest(BaseModel):
    display_name: str | None = None
    hostname: str | None = None
    agent_version: str | None = None


class RegisterResponse(BaseModel):
    system_id: str
    display_name: str


class UsageEventIn(BaseModel):
    suffix: str                      # message id or "syn:<hash>"; server prepends system_id
    session_id: str
    project_name: str = "unknown"
    ts_utc: str
    day: str
    model: str = ""
    model_family: str = "unknown"
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    total_tokens: int = 0
    tool_name: str | None = None
    is_subagent: int = 0
    agent_id: str | None = None


class SyncRequest(BaseModel):
    events: list[UsageEventIn]


class SyncResponse(BaseModel):
    received: int
    inserted: int
    duplicates: int
    failed: int = 0


# ── dashboard ─────────────────────────────────────────────────────────────────
class RankingItem(BaseModel):
    system_id: str
    display_name: str
    total_tokens: int
    pct: float


class SummaryOut(BaseModel):
    today_tokens: int
    week_tokens: int
    month_tokens: int
    total_tokens: int
    active_systems: int
    total_systems: int
    highest: RankingItem | None


class TimeseriesPoint(BaseModel):
    day: str
    values: dict[str, int]           # system_id -> tokens


class TimeseriesOut(BaseModel):
    days: list[str]
    systems: list[RankingItem]
    points: list[TimeseriesPoint]


class ProjectOut(BaseModel):
    project_name: str
    system_id: str
    total_tokens: int
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    sessions: int


class SessionOut(BaseModel):
    session_id: str
    system_id: str
    project_name: str
    model: str
    first_ts: str
    last_ts: str
    input_tokens: int
    output_tokens: int
    cache_tokens: int
    total_tokens: int


# ── admin: users ────────────────────────────────────────────────────────────────
class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = ""
    password: str = Field(min_length=8)
    role: str
    system_ids: list[str] = []


class UserUpdate(BaseModel):
    full_name: str | None = None
    password: str | None = Field(default=None, min_length=8)
    role: str | None = None
    is_active: bool | None = None
    system_ids: list[str] | None = None


class RoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    name: str
    description: str


# ── admin: api keys ─────────────────────────────────────────────────────────────
class ApiKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    system_id: str
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None
    active: bool


class ApiKeyCreate(BaseModel):
    name: str = ""


class ApiKeyCreated(BaseModel):
    key: ApiKeyOut
    api_key: str                     # full key — shown exactly once


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    actor_email: str
    action: str
    target: str
    detail: str
    at: datetime
