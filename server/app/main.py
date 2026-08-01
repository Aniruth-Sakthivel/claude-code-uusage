"""Meterhouse central API — application entrypoint."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .database import Base, SessionLocal, engine
from .migrations import apply_dev_migrations
from .routers import admin, auth, dashboard, systems, usage
from .seed import seed

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Dev bootstrap: create tables, apply additive migrations, seed roles/admin.
    # Production uses Alembic instead.
    Base.metadata.create_all(bind=engine)
    apply_dev_migrations(engine)
    with SessionLocal() as db:
        seed(db)
    yield


app = FastAPI(title="Meterhouse API", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth.router, systems.router, usage.router, dashboard.router, admin.router):
    app.include_router(r)


@app.get("/api/v1/health", tags=["meta"])
def health():
    return {"status": "ok", "service": "meterhouse", "version": __version__}
