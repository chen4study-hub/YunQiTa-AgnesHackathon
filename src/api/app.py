"""Frozen v1 response shape; registry reloads each request for champion switch."""
import json
import math
import hashlib
import joblib
import numpy as np
import os
import asyncio
import sqlite3
from contextlib import asynccontextmanager
from functools import partial
from datetime import datetime, timedelta, timezone
from pathlib import Path
import pandas as pd
from fastapi import FastAPI, HTTPException, Depends
from src.api.rate_limit import check_chat_rate_limit, admit_chat_provider, chat_llm_status
from fastapi.responses import StreamingResponse
from src.api.async_runtime import schedule_pool,chat_pool
from src.agent.chat_engine import events as chat_events, consume as consume_chat
from src.agent.agent_runner import events as agent_events, enabled as agent_loop_enabled
from src.agent.agent_provider import AgentProvider
from typing import Literal
from src.agent.chat_topic_hook import guarded_events, termination
from src.agent.topic_guard import is_terminated
from src.agent.topic_provider import TopicClassificationProvider
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator
from src.agent.display_text import validate_display_date,validate_display_time,render_public_fields
from src.data.adapter import adapt
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives, run
from src.agent.orchestrator import run_agent
from src.agent.tools import get_context,simulate_schedule
from src.agent.chat import answer as tool_answer
from src.agent.provider import OpenAICompatibleProvider, get_llm_status
from src.agent.takeover import display_day

@asynccontextmanager
async def lifespan(application):
    await asyncio.to_thread(refresh_health)
    yield


app = FastAPI(title='Building-energy routing', version='1.0',lifespan=lifespan)
from src.api.ops_router import router as ops_router
app.include_router(ops_router)
from src.api.takeover_router import router as takeover_router; app.include_router(takeover_router)
ROOT = Path(__file__).resolve().parents[2]


class Window(BaseModel):
    model_config = ConfigDict(extra='ignore')
    building_id: str = Field(min_length=1)
    start: datetime
    end: datetime

    @model_validator(mode='after')
    def time_window(self):
        if self.start.tzinfo is None or self.end.tzinfo is None or self.end - self.start != timedelta(hours=1):
            raise ValueError('timezone-aware exact one-hour range required')
        if self.start.minute or self.start.second or self.start.microsecond:
            raise ValueError('hour-aligned start required')
        return self


class DisplayDate(BaseModel):
    display_date: str | None = None

    @field_validator('display_date')
    @classmethod
    def valid_display_date(cls,value):
        return validate_display_date(value)


class ScheduleWindow(Window,DisplayDate):
    constraints: dict[str, float] | None = None
    scenario: str | None = None


class ChatTurn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['user', 'assistant']
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(DisplayDate):
    history: list[ChatTurn] = Field(default_factory=list, max_length=16)
    context_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')
    display_time: str | None = None
    session_id: str | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("session_id")
    @classmethod
    def nonblank_session(cls, value):
        if value is not None and not value.strip():
            raise ValueError("session_id must not be blank")
        return value

    @field_validator('display_time')
    @classmethod
    def valid_display_time(cls,value):
        return validate_display_time(value)

    model_config=ConfigDict(extra='ignore')
    question: str=Field(min_length=1,max_length=2000)
    scenario: str='normal'
    origin: datetime

    @model_validator(mode='after')
    def aligned_origin(self):
        if self.origin.tzinfo is None or self.origin.minute or self.origin.second or self.origin.microsecond:
            raise ValueError('timezone-aware hour-aligned origin required')
        return self


def registry():
    return json.loads((ROOT / 'models/registry.json').read_text(encoding='utf-8'))


def artifact(version):
    if not version or not isinstance(version, str) or not all(c.isalnum() or c in '-_.' for c in version) or '..' in version:
        raise ValueError('invalid champion version')
    return ROOT / 'models' / f'{version}.joblib'


def ready():
    reg = registry()
    return bool(reg['champion'] and artifact(reg['champion']).is_file())


def refresh_health():
    # Startup snapshot only; /health never touches disk, keys or a worker pool.
    try:active=ready()
    except (OSError,KeyError,ValueError):active=False
    app.state.health={'status':'ok','model_ready':active,'llm':get_llm_status()}


refresh_health()


@app.get('/health')
async def health():
    return app.state.health


def exported_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise HTTPException(503, 'export not available or invalid') from exc


@app.get('/buildings')
def buildings():
    return exported_json(ROOT / 'exports/buildings.json')


@app.get('/replay')
def replay_index():
    return exported_json(ROOT / 'exports/replay/index.json')


@app.get('/replay/{scenario}')
def replay_scenario(scenario: str):
    # Public data-only allowlist: no traversal and mock is never served as a real scenario.
    if scenario not in ('normal', 'peak', 'abstain'):
        raise HTTPException(404, 'unknown replay scenario')
    return exported_json(ROOT / 'exports/replay' / f'{scenario}.json')


@app.get('/models')
def models():
    try:
        return registry()
    except (OSError, ValueError):
        raise HTTPException(503, 'model registry unavailable')


def routed_holiday_forecast(building_id, start, end):
    """Explicit building-specific monthly demo route; legacy champion remains separate."""
    routes_path = ROOT / 'configs/prediction_routes.json'
    if not routes_path.exists():
        return None
    route = json.loads(routes_path.read_text(encoding='utf-8')).get(building_id)
    if not route or not route.get('enabled'):
        return None
    if start.year not in route['supported_years']:
        raise HTTPException(422, 'historical demo route supports 2017 only')
    receipt = exported_json(ROOT / route['receipt'])
    month = start.astimezone(timezone.utc).strftime('%Y-%m')
    item = next(x for x in receipt['rows'] if x['month'] == month)
    path = ROOT / item['artifact']
    if hashlib.sha256(path.read_bytes()).hexdigest() != item['artifact_sha256']:
        raise ValueError('holiday artifact hash mismatch')
    bundle = joblib.load(path)  # trusted local, receipt-bound artifact only
    model = bundle['backbone']
    if not model.cfg['features'].get('holidays') or 'holiday' not in model.columns:
        raise ValueError('holiday route has no trained holiday feature')
    target = pd.Timestamp(start.astimezone(timezone.utc))
    if target <= bundle['calibration'].timestamp.max():
        raise HTTPException(422, 'forecast must follow routed model calibration period')
    csv = Path(os.getenv('BUILDING_DATA_CSV', str(ROOT / 'data/observations.csv')))
    frame = adapt(pd.read_csv(csv), model.cfg)
    group = frame[frame.building_id.eq(building_id)]
    if group.empty:
        raise HTTPException(404, 'unknown building')
    if group.timestamp.max() != target - pd.Timedelta(hours=1):
        raise HTTPException(422, 'latest observed hour must be exactly target minus one hour')
    known = group[group.timestamp < target].copy()
    future = known.iloc[[-1]].copy(); future['timestamp'] = target; future['y'] = float('nan')
    f = primitives(model, pd.concat([known, future], ignore_index=True))
    evaluation = f[f.timestamp.eq(target)]
    if len(evaluation) != 1:
        raise HTTPException(422, 'insufficient lag history')
    if route.get('daily_calibration') == 'byron-daily10-v1':
        from src.conformal.byron_daily import one_step
        pred = one_step(bundle, pd.concat([known, future], ignore_index=True), target).iloc[0]
        threshold = float(pred.risk_threshold)
    else:
        pred = run(model, bundle['calibration'], evaluation, .15, 'cqr', quantile_models=bundle['quantile_models']).iloc[0]
        threshold = bundle['risk_threshold']
    vals = {k: float(pred[k]) for k in ('point', 'lower', 'upper', 'confidence')}
    from src.agent.confidence import gate_confidence
    vals['confidence'], _ = gate_confidence(bundle['confidence_lookup'], float(pred.risk_score),
                                          threshold, bool(pred.abstain))
    if not np.isfinite(list(vals.values())).all():
        raise ValueError('nonfinite routed output')
    return dict(building_id=building_id, model_version=route['version'], alpha=float(model.cfg['conformal']['alpha']),
        predictions=[dict(timestamp=target.isoformat().replace('+00:00', 'Z'), **vals,
                          abstain=bool(pred.abstain), abstain_reason=pred.abstain_reason,
                          risk_score=float(pred.risk_score), risk_threshold=float(threshold))])


def forecast(building_id, start, end):
    try:
        routed = routed_holiday_forecast(building_id, start, end)
        if routed is not None:
            return routed
        reg = registry()
        version = reg['champion']
        if not version or not artifact(version).is_file():
            raise HTTPException(503, 'no trained champion available')
        csv = Path(os.getenv('BUILDING_DATA_CSV', str(ROOT / 'data' / 'observations.csv')))
        if not csv.is_file():
            raise HTTPException(503, 'observed hourly meter history unavailable')
        model = ResidualForecaster.load(artifact(version))
        frame = adapt(pd.read_csv(csv), model.cfg)
        group = frame[frame.building_id == building_id]
        if group.empty:
            raise HTTPException(404, 'unknown building')
        # Forecast target is NEXT complete hour only. No test label or future meter reading.
        target = start.astimezone(timezone.utc)
        known = group[group.timestamp < target].copy()
        if known.empty or group.timestamp.max() != target - timedelta(hours=1):
            raise HTTPException(422, 'latest observed hour must be exactly target minus one hour')
        future = known.iloc[[-1]].copy()
        future['timestamp'] = pd.Timestamp(target)
        future['y'] = float('nan')
        merged = pd.concat([known, future], ignore_index=True)
        result = model.predict(merged).frame
        match = result[result.timestamp == target]
        if len(match) != 1:
            raise HTTPException(422, 'insufficient lag history')
        row = match.iloc[0]
        values = {k: float(row[k]) for k in ('point', 'lower', 'upper', 'confidence')}
        if not all(math.isfinite(v) for v in values.values()):
            raise HTTPException(503, 'nonfinite model output')
        return dict(building_id=building_id, model_version=version,
                    alpha=float(model.cfg['conformal']['alpha']), predictions=[dict(
                    timestamp=target.isoformat().replace('+00:00', 'Z'), **values,
                    abstain=bool(row.abstain), abstain_reason=row.abstain_reason)])
    except HTTPException:
        raise
    except (OSError, ValueError, KeyError) as exc:
        raise HTTPException(503, f'forecast unavailable: {exc}') from exc


@app.post('/predict')
def predict(request: Window):
    return forecast(request.building_id, request.start, request.end)


def replay_hour(scenario,origin):
    data=replay_scenario(scenario)
    row=next((h for h in data['hours'] if datetime.fromisoformat(h['t'])==origin),None)
    if row is None:raise HTTPException(422,'origin not available in selected replay')
    from src.data.replay_payload import ensure_hour
    try:row=ensure_hour(data,row)
    except (OSError,ValueError,KeyError,TypeError) as exc:raise HTTPException(503,'agent detail unavailable or mismatched') from exc
    return data,row


def agent_schedule(request,dispatch_enabled):
    try:
        replay_data=None;frozen_agent=None
        if request.scenario:
            replay_data,row=replay_hour(request.scenario,request.start)
            if request.building_id!=replay_data['meta']['building_id']:raise HTTPException(404,'unknown replay building')
            from src.agent.exported_schedule import exported_inputs
            data,context,_,frozen_agent=exported_inputs(replay_data,row,request.constraints)
            data['model_version']=replay_data['meta']['multi_horizon_model_version']
        else:data=forecast(request.building_id,request.start,request.end)
        context_missing=False
        try:
            if replay_data is None:context=get_context(request.building_id,request.start,request.end)
        except ValueError:
            if replay_data is not None:raise
            # Explicit conservative scenario, NOT fabricated measured context. No economics.
            from src.agent.tools import tool_config
            tariff=tool_config()['tariff'];hour=request.start.hour
            period='valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
            context={'hours':[dict(timestamp=data['predictions'][0]['timestamp'],storage_soc=.5,pv_kw=0.,outdoor_temp_c=None,
                tariff_period=period,price_per_kwh=tariff[period],source='missing context; zero battery/PV conservative scenario')]}
            context_missing=True
        # Canonical timestamps align forecast/context exactly, including Z/offset spellings.
        context['hours'][0]['timestamp']=data['predictions'][0]['timestamp']
        initial=context['hours'][0]['storage_soc'];constraints={**(request.constraints or {}),'initial_soc':initial}
        if context_missing:constraints['battery_max_kw']=0.
        result=run_agent(data,context,constraints,provider=OpenAICompatibleProvider(),dispatch_path=ROOT/'logs/dispatch.jsonl',dispatch_enabled=dispatch_enabled,dispatch_current_only=True,
            takeover_date=display_day(request.display_date),frozen_agent=frozen_agent)
        if frozen_agent is not None:
            from src.data.replay_payload import display_precision
            result['storage']=display_precision(row['storage'])
        selected=next(c for c in result['candidates'] if c['candidate_id']==result['selected'])
        estimate=selected['simulation'];manual=result.get('status')=='manual';needs_human=bool(data['predictions'][0]['abstain'] or manual)
        return render_public_fields({**result,'model_version':data['model_version'],'mode':'manual' if manual else 'auto','needs_human':needs_human,
            'estimated_cost':None if manual else estimate.get('estimated_cost'),'estimated_savings':None if manual else estimate.get('estimated_savings'),
            'context_source':'conservative_unobserved' if context_missing else 'historical_replay',
            'explanation':result['reason'],'explanation_source':result['explanation_source'],
            'llm_mode':result['llm']['mode'],'dispatch_enabled':dispatch_enabled and not manual},request.display_date)
    except HTTPException:raise
    except (OSError,sqlite3.Error) as exc:
        raise HTTPException(503,'takeover database unavailable; automatic dispatch stopped') from exc
    except (ValueError,KeyError,TypeError) as exc:
        raise HTTPException(422,'agent context or constraints unavailable/invalid') from exc


@app.post('/schedule')
async def schedule(request: ScheduleWindow):
    return await schedule_pool.run(('schedule',request.model_dump_json()),partial(agent_schedule,request,True))


@app.post('/explain')
async def explain(request: ScheduleWindow):
    result=await schedule_pool.run(('explain',request.model_dump_json()),partial(agent_schedule,request,False))
    return {'building_id':result['building_id'],'model_version':result['model_version'],'text':result['explanation'],
        'needs_human':result['needs_human'],'work_orders':result['work_orders'],'llm_mode':result['llm_mode'],
        'receipt':result['receipt'],'dispatch_enabled':False,'selection_reason':result['selection_reason']}


def chat_provider():
    return AgentProvider() if agent_loop_enabled() else OpenAICompatibleProvider()


def guarded_chat(request, provider):
    # Separate sockets/cancellation; both paths share the same policy gate.
    classifier=TopicClassificationProvider()
    if hasattr(provider, '_rate_limit_llm_status'):
        classifier._rate_limit_llm_status = dict(provider._rate_limit_llm_status)
    def pipeline():
        data,row=replay_hour(request.scenario,request.origin)
        if agent_loop_enabled():
            result=yield from agent_events(request.question,data,row,provider=provider,
                display_date=request.display_date,display_time=request.display_time,
                history=[t.model_dump() for t in request.history],session_id=request.session_id,
                context_id=request.context_id)
        else:
            result=yield from chat_events(request.question,data,row,provider=provider,
                display_date=request.display_date,display_time=request.display_time)
        return {**result,'building_id':data['meta']['building_id'],'origin':row['t']}
    from src.agent.chat_progress import progress_events
    return progress_events(lambda: guarded_events(request.question,[t.model_dump() for t in request.history],request.session_id,pipeline,classifier,
        mode='llm' if chat_llm_status(provider, get_llm_status)['mode']=='real' else 'fallback'),provider)


@app.post('/chat', dependencies=[Depends(check_chat_rate_limit)])
def chat(request: ChatRequest):
    provider=admit_chat_provider(chat_provider, get_llm_status)
    try:result=consume_chat(guarded_chat(request,provider))
    except (ValueError,KeyError,TypeError):
        result={'answer':'不知道','known':False,'needs_human':False,'grounded':True,'tool_trace':[],
            'answer_source':'deterministic_tools','llm_called':False,'reason':'tool_data_unavailable',
            'session_id':request.session_id,'terminated':False,'category':'none','mode':'fallback'}
    return {**result,'origin':result.get('origin',request.origin.isoformat()),
        'llm_mode':result.get('llm_mode',chat_llm_status(provider, get_llm_status)['mode'])}


@app.post('/chat/stream', dependencies=[Depends(check_chat_rate_limit)])
async def chat_stream(request: ChatRequest):
    # Freeze once before sending SSE headers; Redis I/O stays off the event loop.
    provider=await asyncio.to_thread(admit_chat_provider, chat_provider, get_llm_status)
    def encode(event):return 'data: '+json.dumps(event,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n\n'
    async def stream():
        # This runs on the event loop: never wait for admission, file or network I/O.
        # Route owns public step wording: idle chat emits no data-query step.
        # Do not prepend a universal step before knowing the selected tool.
        if request.session_id is not None and is_terminated(request.session_id):
            for event in termination(request.session_id,'terminated','llm' if chat_llm_status(provider, get_llm_status)['mode']=='real' else 'fallback'):
                yield encode(event)
            return
        def pipeline(data,row,provider):
            return guarded_chat(request,provider)
        # Lazy load inside guard: terminated sessions never read building data.
        bridge=chat_pool.events(lambda:(None,None),pipeline,provider)
        try:
            async for event in bridge:
                if event['type']=='done':
                    event={**event,'session_id':request.session_id,
                        'terminated':event.get('terminated',False),'category':event.get('category','none'),
                        'mode':event.get('mode','fallback')}
                yield encode(event)
        finally:await bridge.aclose()
    return StreamingResponse(stream(),media_type='text/event-stream',headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})
