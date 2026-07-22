"""Administrative endpoints. Each guarded by a specific capability."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas, services
from ..core.deps import require
from ..database import get_db
from ..models import User

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


# ── users & roles ───────────────────────────────────────────────────────────────
@router.get("/roles", response_model=list[schemas.RoleOut])
def roles(_: User = Depends(require("manage_users")), db: Session = Depends(get_db)):
    return services.list_roles(db)


@router.get("/users", response_model=list[schemas.UserOut])
def list_users(_: User = Depends(require("manage_users")), db: Session = Depends(get_db)):
    return [services.user_out(u) for u in services.list_users(db)]


@router.post("/users", response_model=schemas.UserOut, status_code=201)
def create_user(body: schemas.UserCreate, actor: User = Depends(require("manage_users")),
                db: Session = Depends(get_db)):
    return services.user_out(services.create_user(db, actor, body))


@router.patch("/users/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: int, body: schemas.UserUpdate,
                actor: User = Depends(require("manage_users")),
                db: Session = Depends(get_db)):
    return services.user_out(services.update_user(db, actor, user_id, body))


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, actor: User = Depends(require("manage_users")),
                db: Session = Depends(get_db)):
    services.delete_user(db, actor, user_id)


# ── systems & api keys ───────────────────────────────────────────────────────────
@router.post("/systems", response_model=schemas.SystemCreated, status_code=201)
def create_system(body: schemas.SystemCreate,
                  actor: User = Depends(require("manage_systems")),
                  db: Session = Depends(get_db)):
    system, full_key = services.create_system(db, actor, body)
    return schemas.SystemCreated(
        system=schemas.SystemOut.model_validate(system), api_key=full_key)


@router.get("/systems/{system_id}/keys", response_model=list[schemas.ApiKeyOut])
def list_keys(system_id: str, _: User = Depends(require("manage_keys")),
              db: Session = Depends(get_db)):
    return services.list_api_keys(db, system_id)


@router.post("/systems/{system_id}/keys", response_model=schemas.ApiKeyCreated, status_code=201)
def create_key(system_id: str, body: schemas.ApiKeyCreate,
               actor: User = Depends(require("manage_keys")),
               db: Session = Depends(get_db)):
    key, full_key = services.create_api_key(db, actor, system_id, body.name)
    return schemas.ApiKeyCreated(key=schemas.ApiKeyOut.model_validate(key), api_key=full_key)


@router.post("/keys/{key_id}/rotate", response_model=schemas.ApiKeyCreated)
def rotate_key(key_id: int, actor: User = Depends(require("manage_keys")),
               db: Session = Depends(get_db)):
    key, full_key = services.rotate_api_key(db, actor, key_id)
    return schemas.ApiKeyCreated(key=schemas.ApiKeyOut.model_validate(key), api_key=full_key)


@router.delete("/keys/{key_id}", status_code=204)
def revoke_key(key_id: int, actor: User = Depends(require("manage_keys")),
               db: Session = Depends(get_db)):
    services.revoke_api_key(db, actor, key_id)


# ── audit ─────────────────────────────────────────────────────────────────────
@router.get("/audit", response_model=list[schemas.AuditOut])
def audit_log(_: User = Depends(require("view_audit")), db: Session = Depends(get_db)):
    return services.list_audit(db)
