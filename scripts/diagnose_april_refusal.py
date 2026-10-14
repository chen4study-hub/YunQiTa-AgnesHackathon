"""Attribution to observed frozen risk components, not causal model explanations."""
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from src.data.adapter import adapt
from src.conformal.replay_calibration import primitives


def main():
    index=json.loads(Path('experiments/demo_monthly_index.json').read_text(encoding='utf-8'))
    item=next(r for r in index['rows'] if r['month']=='2017-04');b=joblib.load(item['artifact']);m=b['backbone'];cq=b['calibration']
    raw=pd.read_csv('data/raw/bdg2/electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron'])
    raw=raw[raw.timestamp>='2016-01-20'].rename(columns={'Hog_office_Byron':'meter_reading'})
    w=pd.read_csv('data/raw/bdg2/weather.csv',usecols=['timestamp','site_id','airTemperature'])
    w=w[w.site_id.eq('Hog')].rename(columns={'airTemperature':'air_temperature'})
    raw=raw.merge(w.drop(columns='site_id'),on='timestamp',how='left',validate='one_to_one');raw['building_id']='Hog_office_Byron';raw['primary_use']='Office'
    f=primitives(m,adapt(raw,m.cfg));d=f[f.timestamp.dt.strftime('%Y-%m-%d').eq('2017-04-09')]
    refs=[np.sort(np.asarray(v)) for v in m._components(cq,cq.scale.to_numpy())]
    components=m._components(d,d.scale.to_numpy());weights=m.cfg['conformal']['risk_weights']
    stats={name:dict(raw_min=float(np.min(v)),raw_max=float(np.max(v)),
        calibration_min=float(np.min(ref)),calibration_max=float(np.max(ref)),
        weighted_mean=float(np.mean(weight*np.searchsorted(ref,v,side='right')/len(ref))))
        for name,v,ref,weight in zip(['scale','lag_disagreement','building_prior','usage_prior'],components,refs,weights)}
    cache=pd.read_csv(item['predictions']);cache['t']=pd.to_datetime(cache.timestamp,utc=True)
    daily=cache[cache.t.dt.strftime('%Y-%m-%d').eq('2017-04-09')]
    results=dict(date='2017-04-09',weekday='Sunday',federal_holiday=False,
        risk_min=float(daily.risk_score.min()),risk_max=float(daily.risk_score.max()),threshold=b['risk_threshold'],
        rejected=int(daily.abstain.sum()),components=stats,calibration_start=str(cq.timestamp.min()),
        calibration_end=str(cq.timestamp.max()),weekend_fraction_cq=float((cq.timestamp.dt.dayofweek>=5).mean()),
        actual_min=float(d.y.min()),actual_max=float(d.y.max()),missing_actual=int(d.y.isna().sum()),
        max_hourly_change=float(d.y.diff().abs().max()),
        holiday_comparison={str(k):dict(n=len(g),rejection=float(g.abstain.mean()),coverage=float(g.loc[~g.abstain,'hit'].mean()))
            for k,g in pd.concat([pd.read_csv(r['predictions']) for r in index['rows']]).groupby('holiday')})
    Path('experiments/april_refusal_diagnosis.json').write_text(json.dumps(results,indent=2),encoding='utf-8');print(json.dumps(results,indent=2))


if __name__=='__main__':main()
