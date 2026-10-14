"""Persistent human takeover API. Operator names are attribution, not authentication."""
import sqlite3
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from src.db.connection import database_path
from src.db.precision import display_precision
from src.db.evidence import EvidenceUnavailable, public_text
from src.db.repository import Conflict, Missing
from src.db.service import TakeoverService
from src.ops.calendar import parse_date


@lru_cache(maxsize=4)
def _service(path):
    from src.db import Database, Repository
    return TakeoverService(Repository(Database(path)))


def get_service():
    return _service(str(database_path()))


@asynccontextmanager
async def lifespan(app):
    # Independent apps may inject their own DB. Including this router runs migrations at startup.
    service = app.dependency_overrides.get(get_service, get_service)()
    service.repository.db.migrate()
    yield


router = APIRouter(lifespan=lifespan)


class TakeoverInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    date: str
    hour: int = Field(ge=0, le=23, strict=True)
    duration_hours: int = Field(ge=1, le=24, strict=True)
    operator_id: str = Field(min_length=1,max_length=100)
    hvac_setpoint_c: float = Field(ge=24,le=27,allow_inf_nan=False)
    storage_mode: Literal['charge','discharge','idle']
    storage_power_kw: float = Field(ge=0,le=500,allow_inf_nan=False)
    reason: str = Field(min_length=1,max_length=2000)
    recommendation_hash: str | None = Field(default=None,max_length=64)
    request_id: str | None = Field(default=None,min_length=1,max_length=100)

    @field_validator('hvac_setpoint_c','storage_power_kw',mode='before')
    @classmethod
    def numeric_controls(cls,value):
        if isinstance(value,bool) or not isinstance(value,(int,float)):
            raise ValueError('控制值应为有限数字')
        return value

    @field_validator('date')
    @classmethod
    def valid_date(cls,value):
        parse_date(value)
        return value

    @field_validator('operator_id','reason')
    @classmethod
    def valid_text(cls,value):
        return public_text(value.strip())


class UpdateInput(TakeoverInput):
    expected_version: int = Field(ge=1,strict=True)


class CancelInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operator_id: str = Field(min_length=1,max_length=100)
    reason: str = Field(min_length=1,max_length=2000)
    expected_version: int | None = Field(default=None,ge=1,strict=True)

    @field_validator('operator_id','reason')
    @classmethod
    def valid_text(cls,value):
        return public_text(value.strip())


def invoke(fn):
    try:
        return fn()
    except Conflict as exc:
        raise HTTPException(409,str(exc)) from exc
    except Missing as exc:
        raise HTTPException(404,str(exc)) from exc
    except EvidenceUnavailable as exc:
        raise HTTPException(503,str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422,str(exc)) from exc
    except sqlite3.OperationalError as exc:
        raise HTTPException(503,'数据库暂不可用，请稍后重试') from exc


def output(response, **fields):
    response.headers['Cache-Control']='no-store'
    return display_precision({'api_version':'1.0','timezone':'Asia/Shanghai',**fields})


@router.get('/takeover/recommendation')
def recommendation(response: Response,date: str,hour: int=Query(ge=0,le=23),service: TakeoverService=Depends(get_service)):
    return output(response,**invoke(lambda: service.recommendation(date,hour)))


@router.post('/takeover')
def create(payload: TakeoverInput,response: Response,service: TakeoverService=Depends(get_service)):
    return output(response,takeover=invoke(lambda: service.create(payload.model_dump())))


@router.get('/takeover/active')
def active(response: Response,date: str,hour: int=Query(ge=0,le=23),service: TakeoverService=Depends(get_service)):
    return output(response,takeover=invoke(lambda: service.repository.get_for_display(date,hour)))


@router.post('/takeover/{identifier}/cancel')
def cancel(identifier: str,payload: CancelInput,response: Response,service: TakeoverService=Depends(get_service)):
    return output(response,takeover=invoke(lambda: service.repository.cancel(identifier,payload.operator_id,payload.reason,payload.expected_version)))


@router.patch('/takeover/{identifier}')
def update(identifier: str,payload: UpdateInput,response: Response,service: TakeoverService=Depends(get_service)):
    values=payload.model_dump(exclude={'expected_version'})
    return output(response,takeover=invoke(lambda: service.update(identifier,values,payload.expected_version)))


@router.get('/takeover/history')
def history(response: Response,date: str,limit: int=Query(default=100,ge=1,le=200),offset: int=Query(default=0,ge=0),service: TakeoverService=Depends(get_service)):
    return output(response,items=invoke(lambda: service.repository.history(date,limit,offset)))


@router.get('/dispatch/receipt')
def receipt(response: Response,date: str,operator_id: str=Query(min_length=1,max_length=100),hour: int=Query(ge=0,le=23),service: TakeoverService=Depends(get_service)):
    return output(response,**invoke(lambda: service.receipt(date,hour,operator_id)))


@router.get('/audit')
def audit(response: Response,date: str,limit: int=Query(default=100,ge=1,le=200),offset: int=Query(default=0,ge=0),entity_type: Literal['takeover','receipt','chat'] | None=None,service: TakeoverService=Depends(get_service)):
    return output(response,items=invoke(lambda: service.repository.audits(date,limit,offset,entity_type)))
