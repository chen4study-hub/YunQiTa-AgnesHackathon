"""Expand the explicitly authored contract sample; deliberately synthetic, never served as real."""
import json
from pathlib import Path
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from jsonschema import Draft202012Validator
from src.agent.dispatch import DATA_SOURCE, score_confidence
from scripts.replay_floor_allocation import USES,floors
from src.data.hvac import attach_hvac
import pandas as pd


def make():
    path = Path('exports/replay/sample.json')
    data = json.loads(path.read_text(encoding='utf-8'))
    start = datetime.fromisoformat(data['meta']['date']).replace(tzinfo=ZoneInfo('America/Chicago'))
    data['schema_version']='1.2';data['meta']['floor_uses']=USES;data['meta']['multi_horizon_model_version']='synthetic-contract-sample';data['meta']['forecast_weather']='persistence_at_origin';data['meta']['mode']='auto';data['meta']['data_source']=DATA_SOURCE;data['meta']['confidence_threshold']=.3
    data['hours'] = []
    for i in range(24):
        point = 100.0
        t=start+timedelta(hours=i)
        allocation=floors(point,t.hour,t.strftime('%Y-%m-%d'))
        data['hours'].append(dict(t=(start + timedelta(hours=i)).isoformat(), actual_kw=101.0,
            point_kw=point, lower_kw=90.0, upper_kw=110.0, confidence=score_confidence(.8+i*.005),risk_score=.8+i*.005,risk_threshold=.7,
            abstain=True, abstain_reason='mock_requires_human', outdoor_temp_c=20.0,
            floors_kw=allocation, storage={'power_kw': 0.0, 'soc': 0.5},
            pv={'power_kw': 0.0}, grid_kw=101.0,
            agent={'status':'handoff', 'source':'mock', 'hvac_setpoint_c':24.0,
                   'actions':[], 'explanation':'示例数据，不代表真实预测；交由人工确认。'}))
    for row in data['hours']:
        origin=datetime.fromisoformat(row['t'])
        row['recent_actual']=[dict(t=(origin-timedelta(hours=1)).isoformat(),actual_kw=101.0),dict(t=origin.isoformat(),actual_kw=101.0)]
        row['forecast_24h']=[]
        for h in range(1,25):
            t=origin+timedelta(hours=h)
            row['forecast_24h'].append(dict(t=t.isoformat(),horizon=h,point_kw=100.,lower_kw=90.,upper_kw=110.,confidence=.2,
                abstain=True,risk_score=.8,risk_threshold=.7,confidence_threshold=.3,floors_kw=floors(100.,t.hour,t.strftime('%Y-%m-%d'))))
    # Authored synthetic thermal fixture, no claim to measured BDG2 sample.
    time=pd.date_range(start.replace(tzinfo=None)-timedelta(hours=1),periods=25,freq='h')
    attach_hvac(data,({'chilledwater':pd.Series(100.,index=time),'steam':pd.Series(50.,index=time)},{}))
    schema = json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema,format_checker=Draft202012Validator.FORMAT_CHECKER).validate(data)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',',':'),allow_nan=False) + '\n', encoding='utf-8')


if __name__ == '__main__':
    make()
