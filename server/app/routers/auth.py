from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import schemas, services
from ..core.deps import get_current_user
from ..core.security import create_access_token
from ..database import get_db
from ..models import User

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.get("/registration-open", response_model=schemas.RegistrationStatus)
def registration_open(db: Session = Depends(get_db)):
    return schemas.RegistrationStatus(open=services.registration_open(db))


@router.post("/register", response_model=schemas.Token, status_code=201)
def register(body: schemas.AdminRegisterRequest, db: Session = Depends(get_db)):
    """Create the first admin account (first run only), returning a token."""
    user = services.register_admin(db, body)
    return schemas.Token(access_token=create_access_token(str(user.id)))


@router.post("/login", response_model=schemas.Token)
def login(body: schemas.LoginRequest, db: Session = Depends(get_db)):
    user = services.authenticate(db, body.email, body.password)
    return schemas.Token(access_token=create_access_token(str(user.id)))


@router.get("/me", response_model=schemas.UserOut)
def me(user: User = Depends(get_current_user)):
    return services.user_out(user)
