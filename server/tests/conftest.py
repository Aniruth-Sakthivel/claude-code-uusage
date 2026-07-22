import os
import pathlib
import sys
import tempfile

# Configure an isolated test DB + secrets BEFORE the app (and its cached
# settings) are imported.
_DB = pathlib.Path(tempfile.gettempdir()) / "claudefleet_test.db"
if _DB.exists():
    _DB.unlink()
os.environ["CLAUDEFLEET_DATABASE_URL"] = f"sqlite:///{_DB.as_posix()}"
os.environ["CLAUDEFLEET_JWT_SECRET"] = "test-secret"
os.environ["CLAUDEFLEET_BOOTSTRAP_ADMIN_EMAIL"] = "admin@test.local"
os.environ["CLAUDEFLEET_BOOTSTRAP_ADMIN_PASSWORD"] = "adminpass123"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import pytest
from fastapi.testclient import TestClient


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


@pytest.fixture
def admin_token(client) -> str:
    # First-run registration creates the initial admin and returns a token.
    r = client.post("/api/v1/auth/register", json={
        "email": "admin@test.local", "full_name": "Admin", "password": "adminpass123"})
    assert r.status_code == 201, r.text
    return r.json()["access_token"]


def make_event(suffix, day="2026-07-22", tokens=100, session_id="s1", project="Github/demo"):
    return {
        "suffix": suffix, "session_id": session_id, "project_name": project,
        "ts_utc": f"{day}T10:00:00+00:00", "day": day, "model": "claude-opus-4-8",
        "model_family": "opus", "input_tokens": tokens, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_creation_tokens": 0, "total_tokens": tokens,
        "tool_name": None, "is_subagent": 0, "agent_id": None,
    }
