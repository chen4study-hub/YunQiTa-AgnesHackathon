"""Owned cancellation probe entry; fixed server clock, no model/network/device dispatch."""
from datetime import datetime
from fastapi import FastAPI
from src.api import app as api
from src.api.takeover_router import router, get_service
from src.db import Database, Repository, TakeoverService
from src.db.time import ZONE
from src.agent import orchestrator


class LocalProvider:
    def choose_candidate(self,*args,**kwargs):
        return {'choice':{},'llm':{'mode':'rule','reason':'key_unavailable'}}


def create_app():
    api.OpenAICompatibleProvider=LocalProvider
    # Receipt is local only. No root dispatch JSONL is written by this test service.
    orchestrator.dispatch_to_bms=lambda plan,*args:dict(count=len(plan)*2,elapsed_ms=0.,transport='log_only',device_connected=False)
    service=TakeoverService(Repository(Database(),lambda:datetime(2026,10,13,3,2,tzinfo=ZONE)))
    app=FastAPI()
    app.dependency_overrides[get_service]=lambda:service
    app.include_router(router)
    app.add_api_route('/schedule',api.schedule,methods=['POST'])
    return app
