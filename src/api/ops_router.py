"""Read-only ops endpoints. Date binding uses the committed calendar."""
import time
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from src.ops.config import canonical, digest, settings
from src.ops.source import get_source
from src.ops import service

router = APIRouter(prefix='/ops', tags=['ops'])
BUILDING = 'Hog_office_Byron'
MAX_MS = 4102444800000


def source_dependency():
    try:
        return get_source()
    except Exception as exc:
        raise HTTPException(503, 'ops source unavailable') from exc


def response(call, *args):
    try:
        raw = canonical(call(*args))
    except service.FloorsInline as exc:
        raise HTTPException(404, 'floors are already included in /ops/day') from exc
    except LookupError as exc:
        raise HTTPException(422, 'date or building is outside ops coverage') from exc
    except (ValueError, OverflowError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, 'ops source unavailable') from exc
    return Response(raw, media_type='application/json',
                    headers={'ETag': '"' + digest(raw) + '"', 'Cache-Control': 'no-cache'})


def building(value):
    if value != BUILDING:
        raise LookupError('unsupported building')
    return value


@router.get('/time')
def ops_time():
    raw = canonical({'schema_version': '1.0', 'epoch_ms': time.time_ns() // 1000000,
                     'timezone': settings()['timezone']})
    return Response(raw, media_type='application/json', headers={'Cache-Control': 'no-store'})


@router.get('/day')
def ops_day(date: str = Query(...), building_id: str = BUILDING, source=Depends(source_dependency)):
    return response(lambda: service.day(source, date, building(building_id)))


@router.get('/floors')
def ops_floors(date: str = Query(...), building_id: str = BUILDING, source=Depends(source_dependency)):
    return response(lambda: service.floors(source, date, building(building_id)))


@router.get('/window')
def ops_window(start_ms: int = Query(..., ge=0, le=MAX_MS),
               end_ms: int = Query(..., ge=0, le=MAX_MS),
               building_id: str = BUILDING, source=Depends(source_dependency)):
    return response(lambda: service.window(source, start_ms, end_ms, building(building_id)))


@router.get('/snapshot')
def ops_snapshot(at_ms: int = Query(..., ge=0, le=MAX_MS),
                 building_id: str = BUILDING, source=Depends(source_dependency)):
    return response(lambda: service.snapshot(source, at_ms, building(building_id)))


@router.get('/history')
def ops_history(start_ms: int = Query(..., ge=0, le=MAX_MS),
                end_ms: int = Query(..., ge=0, le=MAX_MS),
                building_id: str = BUILDING, source=Depends(source_dependency)):
    return response(lambda: service.window(source, start_ms, end_ms, building(building_id), 'history'))
