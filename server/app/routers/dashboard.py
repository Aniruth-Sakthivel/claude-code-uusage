from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from .. import schemas, services
from ..core.deps import get_current_user
from ..database import get_db
from ..models import User

router = APIRouter(prefix="/api/v1/dashboard", tags=["dashboard"])

_RANGE_DAYS = {"today": 1, "7d": 7, "30d": 30, "90d": 90}


def _since(range_: str) -> str | None:
    from datetime import date, timedelta
    days = _RANGE_DAYS.get(range_)
    if not days:
        return None
    return (date.today() - timedelta(days=days - 1)).isoformat()


@router.get("/summary", response_model=schemas.SummaryOut)
def summary(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return services.build_summary(db, user)


@router.get("/ranking", response_model=list[schemas.RankingItem])
def ranking(range: str = Query("7d"), user: User = Depends(get_current_user),
            db: Session = Depends(get_db)):
    return services.build_ranking(db, user, _since(range))


@router.get("/timeseries", response_model=schemas.TimeseriesOut)
def timeseries(range: str = Query("7d"), user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    return services.build_timeseries(db, user, _RANGE_DAYS.get(range, 7))
