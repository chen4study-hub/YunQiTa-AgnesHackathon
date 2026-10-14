"""Attach issued-at-t forecasts; preserve existing current-hour Agent records, no LLM/network."""
import hashlib
import json
from pathlib import Path
from datetime import datetime,timedelta
import pandas as pd
from jsonschema import Draft202012Validator
from scripts.replay_floor_allocation import USES,floors
from src.data.hvac import load_meters,attach_hvac


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_sources():
    index=json.loads(Path('experiments/multi_horizon_v3_index.json').read_text());caches={}
    daily_path=Path('experiments/round78_calibration.json')
    daily=json.loads(daily_path.read_text()) if daily_path.exists() else None
    for item in index['rows']:
        if sha(item['predictions'])!=item['predictions_sha256'] or sha(item['artifact'])!=item['artifact_sha256']:raise ValueError('Multi-horizon integrity failed')
        source=next(r for r in daily['rows'] if r['month']==item['month']) if daily else None
        if source and sha(source['multi_path'])!=source['multi_sha256']:raise ValueError('daily forecast cache integrity failed')
        d=pd.read_csv(source['multi_path'] if source else item['predictions']);d['wall']=pd.to_datetime(d.origin,utc=True).dt.strftime('%Y-%m-%d %H:%M:%S')
        caches[item['month']]=d.set_index(['wall','horizon'])
    if daily:index['daily_calibration']=daily['version']
    actual=pd.read_csv('data/raw/bdg2/electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron']).set_index('timestamp').Hog_office_Byron
    return index,caches,actual,load_meters()


def attach(data,sources):
    index,caches,actual,thermal=sources;data['schema_version']='1.4'
    data['meta'].pop('agent_detail_file',None)
    data['meta']['floor_uses']=USES;data['meta']['multi_horizon_model_version']=index['version']
    data['meta']['forecast_weather']='persistence_at_origin'
    for row in data['hours']:
        origin=datetime.fromisoformat(row['t']);wall=origin.strftime('%Y-%m-%d %H:%M:%S')
        predictions=caches[origin.strftime('%Y-%m')].loc[wall].sort_index()
        if list(predictions.index)!=list(range(1,25)):raise ValueError('Missing horizon')
        row['recent_actual']=[dict(t=t.isoformat(),actual_kw=round(float(actual.loc[t.strftime('%Y-%m-%d %H:%M:%S')]),1)) for t in [origin-timedelta(hours=1),origin]]
        row['floors_kw']=floors(row['point_kw'],origin.hour,origin.strftime('%Y-%m-%d'));row['forecast_24h']=[]
        for h,p in predictions.iterrows():
            target=origin+timedelta(hours=int(h));point=round(float(p.point),1)
            row['forecast_24h'].append(dict(t=target.isoformat(),horizon=int(h),point_kw=point,lower_kw=round(float(p.lower),1),upper_kw=round(float(p.upper),1),
                confidence=float(p.confidence),abstain=bool(p.abstain),risk_score=float(p.risk_score),risk_threshold=float(p.risk_threshold),
                confidence_threshold=float(p.confidence_threshold),floors_kw=floors(point,target.hour,target.strftime('%Y-%m-%d'))))
    data=attach_hvac(data,thermal)
    data['schema_version']='1.4'  # Envelope upgrade only; frozen thermal implementation unchanged.
    from src.agent.display_text import wording_text
    data['energy_summary']['label']=wording_text(data['energy_summary']['label'])
    return data


def main():
    sources=load_sources();schema=json.loads(Path('contracts/replay-1.4.schema.json').read_text(encoding='utf-8'))
    validator=Draft202012Validator(schema,format_checker=Draft202012Validator.FORMAT_CHECKER);prepared=[];counts={}
    for scenario in ['normal','peak','abstain']:
        path=Path(f'exports/replay/{scenario}.json')
        from src.data.replay_payload import load_replay
        data=load_replay(scenario)
        data=attach(data,sources);validator.validate(data)
        prepared.append((path,json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False)))
        from collections import Counter
        counts[scenario]=dict(Counter(h['agent']['source'] for h in data['hours']))
    for path,content in prepared:path.write_text(content,encoding='utf-8')
    receipt=dict(status='completed',schema_version='1.4',multi_horizon_model_version=sources[0]['version'],
        index_sha256=sha('experiments/multi_horizon_v3_index.json'),export_sha256={p.name:sha(p) for p,c in prepared},
        agent_records_preserved=True,thermal_sources=sources[3][1],new_llm_calls=0,agent_source_counts=counts,device_connected=False,
        note='Current hour fields/Agent remain legacy historical1step; forecast_24h uses origin-causal direct24 cache. Floor estimates updated in both.')
    Path('experiments/future24_export.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    from scripts.compact_replay import main as compact
    compact();print(json.dumps(receipt,indent=2))


if __name__=='__main__':main()
