"""Saved-prediction May diagnosis only; no fitting or retuning."""
import json
from pathlib import Path
import numpy as np
import pandas as pd


def main():
    source=pd.read_csv('data/byron2017.csv');source['timestamp']=pd.to_datetime(source.timestamp,utc=True)
    source['weather_past']=source.air_temperature.ffill().shift(1)
    source['load_past']=source.meter_reading.shift(1)
    train=source[source.timestamp<pd.Timestamp('2017-04-03',tz='UTC')]
    results={}
    for name in ('replay_lgb_cqr','expanded_holiday_lgb_cqr','xgb_static'):
        pred=pd.read_csv(f'data/monthly_backtest/2017-05_{name}.csv')
        pred['timestamp']=pd.to_datetime(pred.timestamp,utc=True)
        d=pred.merge(source[['timestamp','weather_past','load_past']],on='timestamp',validate='one_to_one')
        d['error']=abs(d.y-d.point);d['signed_error']=d.point-d.y
        d['weather_ood']=(d.weather_past<train.weather_past.min())|(d.weather_past>train.weather_past.max())
        daily=d.groupby(d.timestamp.dt.strftime('%Y-%m-%d')).agg(mae=('error','mean'),actual=('y','mean'),point=('point','mean'))
        results[name]=dict(mae=float(d.error.mean()),bias=float(d.signed_error.mean()),
            first_half_mae=float(d[d.timestamp.dt.day<=15].error.mean()),second_half_mae=float(d[d.timestamp.dt.day>15].error.mean()),
            weather_training_range=[float(train.weather_past.min()),float(train.weather_past.max())],
            weather_groups={str(k):dict(n=len(g),mae=float(g.error.mean()),bias=float(g.signed_error.mean())) for k,g in d.groupby('weather_ood')},
            persistence_mae=float(abs(d.y-d.load_past).mean()),worst_days=daily.sort_values('mae',ascending=False).head(5).to_dict(orient='index'),
            missing_actual=int(d.y.isna().sum()))
    Path('experiments/may_diagnosis.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    print(json.dumps(results,indent=2))


if __name__=='__main__':main()
