"""2017 monthly retraining: all training/calibration strictly precedes target month."""
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar
from src.data.adapter import adapt,config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives,run,summary
from scripts.search_byron import fit_quantiles


def split_month(frame,start,calibration_days=28):
    cal_start=start-pd.Timedelta(days=calibration_days)
    end=start+pd.offsets.MonthBegin(1)
    return (frame[frame.timestamp<cal_start],
            frame[(frame.timestamp>=cal_start)&(frame.timestamp<start)],
            frame[(frame.timestamp>=start)&(frame.timestamp<end)])


def measured(pred):
    retained=pred[~pred.abstain]
    return dict(n=len(pred),retained_n=len(retained),rejection_rate=float(pred.abstain.mean()),
        retained_picp=float(retained.hit.mean()) if len(retained) else None,
        retained_mae=float(abs(retained.y-retained.point).mean()) if len(retained) else None,
        all_mae=float(abs(pred.y-pred.point).mean()),
        interval_score=float((pred.upper-pred.lower+2/.095*(np.maximum(pred.lower-pred.y,0)+np.maximum(pred.y-pred.upper,0))).mean()))


def main():
    output=Path('experiments/monthly_backtest_results.json')
    if output.exists():raise FileExistsError('Monthly result immutable; version new run')
    plan_path=Path('experiments/monthly_backtest_plan.json');plan=json.loads(plan_path.read_text(encoding='utf-8'))
    root=Path('data/raw/bdg2')
    raw=pd.read_csv(root/'electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron'])
    raw=raw[raw.timestamp>='2016-01-20 00:00:00'].rename(columns={'Hog_office_Byron':'meter_reading'})
    assert not raw.meter_reading.isna().any()
    weather=pd.read_csv(root/'weather.csv',usecols=['timestamp','site_id','airTemperature'])
    weather=weather[weather.site_id.eq('Hog')].rename(columns={'airTemperature':'air_temperature'})
    raw=raw.merge(weather[['timestamp','air_temperature']],on='timestamp',how='left',validate='one_to_one')
    raw['building_id']='Hog_office_Byron';raw['primary_use']='Office'
    cfg=config('configs/byron2017.yaml');cfg['conformal']['rejection_fraction']=plan['rho']
    data=adapt(raw,cfg)
    holidays=USFederalHolidayCalendar().holidays('2016-01-01','2017-12-31').strftime('%Y-%m-%d').tolist()
    rows=[];cache_dir=Path('data/monthly_backtest');cache_dir.mkdir(parents=True,exist_ok=True)
    for month in range(1,13):
        start=pd.Timestamp(year=2017,month=month,day=1,tz='UTC')
        for name in plan['candidates']:
            local_cfg=copy.deepcopy(cfg)
            source=data if name.startswith('expanded') else data[data.timestamp.dt.year.eq(2017)]
            if name.startswith('expanded'):local_cfg['features']['holidays']=holidays
            train,cal,ev=split_month(source,start,plan['calibration_days'])
            entry=dict(month=start.strftime('%Y-%m'),candidate=name)
            if len(train)<plan['minimum_training_days']*24 or len(cal)!=plan['calibration_days']*24:
                rows.append(dict(**entry,status='skipped_insufficient_past_history',train_hours=len(train),calibration_hours=len(cal)))
                print(json.dumps(rows[-1]),flush=True);continue
            assert train.timestamp.max()<cal.timestamp.min() and cal.timestamp.max()<ev.timestamp.min()
            model=ResidualForecaster(local_cfg).fit(train,cal)
            if name=='xgb_static':
                from scripts.research_composite import xgb_model
                xcfg=config('configs/byron2017_xgb.yaml');model=xgb_model(model,train,cal,xcfg)
                quantiles=None;method='static'
            else:quantiles=fit_quantiles(model,train);method='cqr'
            # Evaluation rows enter only causal feature building, never fit or Cq.
            f=primitives(model,source[source.timestamp<start+pd.offsets.MonthBegin(1)])
            ct=sorted(cal.timestamp.unique());cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])]
            evaluation=f[f.timestamp.isin(ev.timestamp)].sort_values('timestamp')
            pred=run(model,cq,evaluation,plan['rho'],method,quantile_models=quantiles)
            pred['holiday']=pred.timestamp.dt.strftime('%Y-%m-%d').isin(holidays)
            path=cache_dir/f'{start:%Y-%m}_{name}.csv';pred.to_csv(path,index=False)
            row=dict(**entry,status='completed',train_start=str(train.timestamp.min()),train_end=str(train.timestamp.max()),
                calibration_start=str(cal.timestamp.min()),calibration_end=str(cal.timestamp.max()),
                evaluation_start=str(ev.timestamp.min()),evaluation_end=str(ev.timestamp.max()),
                metrics=measured(pred),holiday_metrics=measured(pred[pred.holiday]) if pred.holiday.any() else None,
                predictions=str(path),predictions_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            rows.append(row)
            # Incremental checkpoint makes a background failure auditable.
            Path('experiments/monthly_backtest_checkpoint.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
            print(json.dumps(row),flush=True)
    completed=[r for r in rows if r['status']=='completed']
    flat=[dict(month=r['month'],candidate=r['candidate'],**r['metrics']) for r in completed]
    pd.DataFrame(flat).to_csv('experiments/monthly_backtest_metrics.csv',index=False)
    result=dict(status='completed',plan_sha256=hashlib.sha256(plan_path.read_bytes()).hexdigest(),
        rows=rows,completed=len(completed),skipped=len(rows)-len(completed),
        no_future_training=True,hyperparameters_retuned=False,replay_updated=False)
    output.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'completed':len(completed),'skipped':len(rows)-len(completed)}),flush=True)


if __name__=='__main__':main()
