from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .. import schemas, services
from ..core import security
from ..core.deps import get_current_user
from ..database import get_db
from ..models import User

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
_bearer = HTTPBearer(auto_error=True)


@router.get("/registration-open", response_model=schemas.RegistrationStatus)
def registration_open(db: Session = Depends(get_db)):
    return schemas.RegistrationStatus(open=services.registration_open(db))


@router.post("/provision", response_model=schemas.UserOut, status_code=200)
def provision(
    creds: HTTPAuthorizationCredentials = Depends(_bearer),
    db: Session = Depends(get_db),
):
    """Called by the frontend right after Supabase sign-up/sign-in.

    Ensures a local User row exists for this Supabase identity (the first
    ever becomes admin); returns 403 if no local account exists and
    registration is closed (an admin must create the account first).
    """
    payload = security.decode_supabase_token(creds.credentials)
    user = services.provision_user(
        db, supabase_user_id=payload["sub"],
        email=payload.get("email", ""),
        full_name=(payload.get("user_metadata") or {}).get("full_name", ""))
    return services.user_out(user)


@router.get("/me", response_model=schemas.UserOut)
def me(user: User = Depends(get_current_user)):
    return services.user_out(user)
