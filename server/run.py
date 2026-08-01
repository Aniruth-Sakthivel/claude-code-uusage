"""One-command launcher for the Meterhouse central server.

    cd server
    pip install -e .          # first time only
    python run.py             # starts the API on http://127.0.0.1:8000

On the very first run it automatically creates the SQLite database, applies
migrations, and seeds the four roles. You then create the first admin account
from the web app (registration is open only until the first user exists).
Everything is configurable via METERHOUSE_* environment variables
(see app/config.py).
"""

from __future__ import annotations

import os

import uvicorn

from app.config import get_settings


def main() -> None:
    s = get_settings()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))

    print("=" * 64)
    print("  Meterhouse central server")
    print("=" * 64)
    print(f"  API:        http://{host}:{port}")
    print(f"  API docs:   http://{host}:{port}/docs")
    print(f"  Database:   {s.database_url}")
    print("  First run: open the web app and create your admin account")
    print("             (registration is open only until the first user exists).")
    if not s.supabase_url:
        print("  WARNING: METERHOUSE_SUPABASE_URL is not set — auth will not work.")
    print("=" * 64)

    uvicorn.run("app.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
