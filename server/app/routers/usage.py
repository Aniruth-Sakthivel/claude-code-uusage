"""Agent-facing endpoints. Authenticated by API key (never a user JWT)."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas, services
from ..core.deps import get_current_agent
from ..database import get_db
from ..models import System

router = APIRouter(prefix="/api/v1", tags=["agent"])


@router.post("/systems/register", response_model=schemas.RegisterResponse)
def register(body: schemas.RegisterRequest, system: System = Depends(get_current_agent),
             db: Session = Depends(get_db)):
    system = services.register_agent(db, system, body.display_name, body.hostname,
                                     body.agent_version)
    return schemas.RegisterResponse(system_id=system.system_id,
                                    display_name=system.display_name)


@router.post("/systems/heartbeat")
def heartbeat(system: System = Depends(get_current_agent), db: Session = Depends(get_db)):
    services.heartbeat(db, system)
    return {"ok": True}


@router.post("/usage/sync", response_model=schemas.SyncResponse)
def sync(body: schemas.SyncRequest, system: System = Depends(get_current_agent),
         db: Session = Depends(get_db)):
    return services.ingest_usage(db, system, body.events)
