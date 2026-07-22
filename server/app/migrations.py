"""Lightweight additive migrations for the SQLite dev bootstrap.

Production uses Alembic. For the dev/first-run path (create_all + seed), this
adds any columns that were introduced after a database was first created, so an
existing dev DB keeps its data instead of needing a rebuild. Idempotent and
SQLite-only; a no-op on other backends (Alembic owns those).
"""

from __future__ import annotations

from sqlalchemy import Engine

# table -> {column: column definition}
_ADDITIVE: dict[str, dict[str, str]] = {
    "systems": {
        "owner": "TEXT DEFAULT ''",
        "location": "TEXT DEFAULT ''",
        "environment": "TEXT DEFAULT ''",
        "notes": "TEXT DEFAULT ''",
    },
}


def apply_dev_migrations(engine: Engine) -> None:
    if engine.dialect.name != "sqlite":
        return
    with engine.begin() as conn:
        for table, columns in _ADDITIVE.items():
            existing = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            if not existing:
                continue  # table doesn't exist yet; create_all made it with all columns
            for name, decl in columns.items():
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
