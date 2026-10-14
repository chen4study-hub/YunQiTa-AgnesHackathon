"""Attach origin-weather only; future persistence, humidity derived not measured."""
import json,math,hashlib
from pathlib import Path
import pandas as pd
from jsonschema import Draft202012Validator


def humidity(t,dew):
    if pd.isna(t) or pd.isna(dew):return None
    return round(min(100.,max(0.,100*math.exp(17.625*dew/(243.04+dew)-17.625*t/(243.04+t)))),1)


def main():
    raw=Path('data/raw/bdg2/weather.csv');w=pd.read_csv(raw,usecols=['timestamp','site_id','airTemperature','dewTemperature']);w=w[w.site_id=='Hog'].set_index('timestamp')
    schema=json.loads(Path('contracts/replay-1.4.schema.json').read_text(encoding='utf-8'));v=Draft202012Validator(schema);count=0
    for name in ['normal','peak','abstain']:
        p=Path(f'exports/replay/{name}.json')
        from src.data.replay_payload import load_replay
        d=load_replay(name);d['schema_version']='1.4';d['meta'].pop('agent_detail_file',None)
        for r in d['hours']:
            key=r['t'][:19].replace('T',' ');a=w.loc[key];t=a.airTemperature;dew=a.dewTemperature
            weather={'outdoor_temp_c':None if pd.isna(t) else round(float(t),1),'relative_humidity_pct':humidity(t,dew),'dew_temp_c':None if pd.isna(dew) else round(float(dew),1),'source_timestamp':r['t'],'basis':'origin_observed_temperature; humidity derived from temperature/dewpoint using Magnus, not measured RH'}
            r['weather']=weather
            for f in r['forecast_24h']:f['weather']={**weather,'basis':'origin_persistence; not target-time measured or weather forecast'}
            count+=1
        v.validate(d);p.write_text(json.dumps(d,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    from scripts.compact_replay import main as compact
    compact()
    hashes={n+'.json':hashlib.sha256(Path(f'exports/replay/{n}.json').read_bytes()).hexdigest() for n in ['normal','peak','abstain']}
    for n in ['agent_replay_export','future24_export']:
        p=Path(f'experiments/{n}.json');d=json.loads(p.read_text());d['export_sha256']=hashes;p.write_text(json.dumps(d,indent=2),encoding='utf-8')
    Path('experiments/weather_context_export.json').write_text(json.dumps({'status':'passed','hours':count,'raw_weather_sha256':hashlib.sha256(raw.read_bytes()).hexdigest(),'humidity':'Magnus-derived from origin T/dewpoint; null if missing','future':'origin persistence, no target weather leakage','new_llm_calls':0,'export_sha256':hashes},indent=2),encoding='utf-8')


if __name__=='__main__':main()
