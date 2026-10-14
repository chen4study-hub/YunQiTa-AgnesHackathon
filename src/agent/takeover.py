"""Live database overlay; offline exports never consult live takeover state."""
import copy
from datetime import datetime
from zoneinfo import ZoneInfo
from .display_text import number_text,unit_text,wording_text


def display_day(value=None):
    return value or datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()


def lookup(date,hour,building_id=None):
    from src.db import get_active_takeover
    record=get_active_takeover(date,hour)
    if record and building_id and record['building_id']!=building_id:
        raise ValueError('takeover building mismatch')
    return record


def plan_records(forecast,date):
    origin=datetime.fromisoformat(forecast['predictions'][0]['timestamp'].replace('Z','+00:00'))
    day=datetime.fromisoformat(display_day(date)).date();out={}
    for prediction in forecast['predictions']:
        stamp=datetime.fromisoformat(prediction['timestamp'].replace('Z','+00:00')).astimezone(origin.tzinfo)
        target=(day+(stamp.date()-origin.date())).isoformat()
        record=lookup(target,stamp.hour,forecast['building_id'])
        if record:out[prediction['timestamp']]=record
    return out


def record_text(record):
    mode={'charge':'充电','discharge':'放电','idle':'待机'}[record['storage_mode']]
    text=f"当前由{record['operator_id']}接管，空调设定 {record['hvac_setpoint_c']:.1f} °C，储能{mode}"
    if mode!='待机':text+=f" {record['storage_power_kw']:.1f} kW"
    text+='。接管原因：'+record['reason']+'；本小时不再自动下发。'
    return number_text(wording_text(unit_text(text)))


def overlay(result,records,current):
    out=copy.deepcopy(result)
    out['takeovers']=[dict(r) for r in {r['id']:r for r in records.values()}.values()]
    for command in out['plan']:
        record=records.get(command['timestamp'])
        if record:command.update(hvac_setpoint_c=record['hvac_setpoint_c'],battery_kw=record['battery_kw'],
            action='manual',source='manual',reason=record_text(record))
    out['status']='manual' if current in records else ('handoff' if out['plan'][0]['action']=='human_review' else 'executed')
    if current in records:
        out['source']='manual';out['reason']=record_text(records[current]);out['explanation_source']='template'
        out['active_takeover']=records[current]
    return out
