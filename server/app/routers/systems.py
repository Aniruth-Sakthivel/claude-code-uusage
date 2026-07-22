from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas, services
from ..core.deps import get_current_user
from ..database import get_db
from ..models import User

router = APIRouter(prefix="/api/v1", tags=["systems"])


@router.get("/systems", response_model=list[schemas.SystemOut])
def list_systems(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Scoped server-side: developers only ever receive their assigned systems.
    return services.decorate_systems(db, user)


@router.get("/projects", response_model=list[schemas.ProjectOut])
def list_projects(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from ..core.rbac import visible_system_ids
    from .. import repositories as repo
    return repo.projects(db, visible_system_ids(user))


@router.get("/sessions", response_model=list[schemas.SessionOut])
def list_sessions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from ..core.rbac import visible_system_ids
    from .. import repositories as repo
    return repo.sessions(db, visible_system_ids(user))
