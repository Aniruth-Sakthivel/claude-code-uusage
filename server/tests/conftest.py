import os
import pathlib
import sys
import tempfile
import uuid

# Configure an isolated test DB + secrets BEFORE the app (and its cached
# settings) are imported. This suite is now an integration suite: user auth
# is Supabase Auth, so it needs a real Supabase project (CLAUDEFLEET_SUPABASE_*
# env vars) and network access. It creates and signs in real Supabase users.
_DB = pathlib.Path(tempfile.gettempdir()) / "claudefleet_test.db"
if _DB.exists():
    _DB.unlink()
os.environ["CLAUDEFLEET_DATABASE_URL"] = f"sqlite:///{_DB.as_posix()}"
os.environ.setdefault("CLAUDEFLEET_BOOTSTRAP_ADMIN_EMAIL", f"admin-{uuid.uuid4().hex[:8]}@test.local")
os.environ.setdefault("CLAUDEFLEET_BOOTSTRAP_ADMIN_PASSWORD", "adminpass123")
os.environ.setdefault("CLAUDEFLEET_BOOTSTRAP_ADMIN_FULL_NAME", "Admin")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient

_REQUIRED_SUPABASE_ENV = (
    "CLAUDEFLEET_SUPABASE_URL", "CLAUDEFLEET_SUPABASE_ANON_KEY",
    "CLAUDEFLEET_SUPABASE_SERVICE_ROLE_KEY", "CLAUDEFLEET_SUPABASE_JWT_SECRET",
)


@pytest.fixture(autouse=True)
def _require_supabase_env():
    missing = [v for v in _REQUIRED_SUPABASE_ENV if not os.environ.get(v)]
    if missing:
        pytest.skip(f"missing env for Supabase integration tests: {', '.join(missing)}")


@pytest.fixture
def client():
    from app.database import Base, SessionLocal, engine
    from app.main import app
    from app.seed import seed

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        seed(db)
    with TestClient(app) as c:
        yield c


def auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def supabase_sign_in(email: str, password: str) -> str:
    """Sign in against the real Supabase project and return the access token."""
    from app.config import get_settings
    from supabase import create_client

    settings = get_settings()
    sb = create_client(settings.supabase_url, settings.supabase_anon_key)
    session = sb.auth.sign_in_with_password({"email": email, "password": password})
    return session.session.access_token


def supabase_sign_up(client, email: str, password: str, full_name: str = "") -> str:
    """Sign up against the real Supabase project, provision the local user
    via the app, and return the access token."""
    from app.config import get_settings
    from supabase import create_client

    settings = get_settings()
    sb = create_client(settings.supabase_url, settings.supabase_anon_key)
    result = sb.auth.sign_up({
        "email": email, "password": password,
        "options": {"data": {"full_name": full_name}},
    })
    token = result.session.access_token
    r = client.post("/api/v1/auth/provision", headers=auth_header(token))
    assert r.status_code == 200, r.text
    return token


@pytest.fixture
def admin_token(client) -> str:
    # Bootstrapped credentials are created at startup via env vars.
    email = os.environ["CLAUDEFLEET_BOOTSTRAP_ADMIN_EMAIL"]
    password = os.environ["CLAUDEFLEET_BOOTSTRAP_ADMIN_PASSWORD"]
    return supabase_sign_in(email, password)


def make_event(suffix, day="2026-07-22", tokens=100, session_id="s1", project="Github/demo"):
    return {
        "suffix": suffix, "session_id": session_id, "project_name": project,
        "ts_utc": f"{day}T10:00:00+00:00", "day": day, "model": "claude-opus-4-8",
        "model_family": "opus", "input_tokens": tokens, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_creation_tokens": 0, "total_tokens": tokens,
        "tool_name": None, "is_subagent": 0, "agent_id": None,
    }
