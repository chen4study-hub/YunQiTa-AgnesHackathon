"""Frozen 2016 selection, once-only 2017 evaluation; no demo writes."""
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar
from src.data.adapter import adapt,config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives,run
from scripts.search_byron import fit_quantiles
from scripts.monthly_backtest import split_month

ROOT=Path('experiments');PLAN=ROOT/'holiday_calibration_v1_plan.json'


def metrics(frame):
    kept=frame[~frame.abstain]
    return dict(n=len(frame),days=int(pd.to_datetime(frame.timestamp).dt.date.nunique()),retained_n=len(kept),
        rejection=float(frame.abstain.mean()) if len(frame) else None,coverage=float(kept.hit.mean()) if len(kept) else None,
        width=float((kept.upper-kept.lower).mean()) if len(kept) else None)


def grouped_metrics(frame):
    return {name:metrics(frame[frame.holiday.eq(flag)]) for name,flag in [('holiday',True),('ordinary',False)]}


def grouped_predict(model,cq,evaluation,quantiles,plan):
    """Fit each group only on prior Cq, not current evaluation labels."""
    records=[];fallback=0
    for flag,ev in evaluation.groupby('holiday'):
        group=cq[cq.holiday.eq(flag)]
        if len(group)<plan['minimum_group_cq_hours']:group=cq;fallback+=len(ev)
        records.append(run(model,group,ev,plan['rho'],'cqr',quantile_models=quantiles))
    result=pd.concat(records).sort_values('timestamp')
    return result,fallback


def month_predictions(data,start,variant,plan):
    days=28 if variant=='pooled28' else 90
    train,cal,ev=split_month(data,start,days)
    cfg=config('configs/byron2017.yaml');cfg['conformal']['rejection_fraction']=plan['rho']
    cfg['features']['holidays']=USFederalHolidayCalendar().holidays('2016-01-01','2017-12-31').strftime('%Y-%m-%d').tolist()
    model=ResidualForecaster(cfg).fit(train,cal);quantiles=fit_quantiles(model,train)
    f=primitives(model,data[data.timestamp<start+pd.offsets.MonthBegin(1)])
    ct=sorted(cal.timestamp.unique());cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])]
    evaluation=f[f.timestamp.isin(ev.timestamp)].sort_values('timestamp')
    assert train.timestamp.max()<cal.timestamp.min() and cq.timestamp.max()<evaluation.timestamp.min()
    fallback=0
    if variant=='holiday90':pred,fallback=grouped_predict(model,cq,evaluation,quantiles,plan)
    else:pred=run(model,cq,evaluation,plan['rho'],'cqr',quantile_models=quantiles)
    pred['holiday']=pred.timestamp.dt.strftime('%Y-%m-%d').isin(cfg['features']['holidays'])
    return pred,dict(month=str(start.date()),variant=variant,train_end=str(train.timestamp.max()),
        cq_start=str(cq.timestamp.min()),cq_end=str(cq.timestamp.max()),holiday_cq_hours=int(cq.holiday.sum()),
        group_fallback_hours=fallback,metrics=grouped_metrics(pred))


def load_data():
    raw=pd.read_csv('data/raw/bdg2/electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron'])
    raw=raw[raw.timestamp>='2016-01-20'].rename(columns={'Hog_office_Byron':'meter_reading'})
    w=pd.read_csv('data/raw/bdg2/weather.csv',usecols=['timestamp','site_id','airTemperature'])
    w=w[w.site_id.eq('Hog')].rename(columns={'airTemperature':'air_temperature'})
    raw=raw.merge(w[['timestamp','air_temperature']],on='timestamp',how='left',validate='one_to_one')
    raw['building_id']='Hog_office_Byron';raw['primary_use']='Office'
    return adapt(raw,config('configs/byron2017.yaml'))


def choose(summary,plan):
    base=summary['pooled28'];eligible=[]
    for name in plan['candidates']:
        s=summary[name]
        if all(s[g]['coverage'] is not None and s[g]['coverage']>=.905 for g in ('holiday','ordinary')) and s['ordinary']['rejection']<=base['ordinary']['rejection']+.02:eligible.append(name)
    key=lambda n:(summary[n]['holiday']['rejection'],summary[n]['holiday']['width'],n)
    if eligible:return min(eligible,key=key),True
    return min(plan['candidates'],key=lambda n:(sum(max(0.,.905-(summary[n][g]['coverage'] or 0.)) for g in ('holiday','ordinary')),summary[n]['holiday']['rejection'],n)),False


def main():
    result=ROOT/'holiday_calibration_v1_results.json';selection=ROOT/'holiday_calibration_v1_selection.json'
    if result.exists() or selection.exists():raise FileExistsError('Immutable research; do not reevaluate2017')
    plan=json.loads(PLAN.read_text());data=load_data();dev=data[data.timestamp.dt.year.eq(2016)]
    summary={};rows=[]
    for name in ['pooled28']+plan['candidates']:
        frames=[]
        for month in range(7,13):
            p,r=month_predictions(dev,pd.Timestamp(year=2016,month=month,day=1,tz='UTC'),name,plan)
            frames.append(p);rows.append(r);print(json.dumps(r),flush=True)
        summary[name]=grouped_metrics(pd.concat(frames))
    selected,passed=choose(summary,plan)
    decision=dict(selected=selected,development_gate_passed=passed,development=summary,
        plan_sha256=hashlib.sha256(PLAN.read_bytes()).hexdigest(),development_rows=rows)
    selection.write_text(json.dumps(decision,indent=2),encoding='utf-8')
    # Freeze selection on disk before any candidate2017 outcome is evaluated.
    final=[];final_rows=[]
    for month in range(1,13):
        p,r=month_predictions(data,pd.Timestamp(year=2017,month=month,day=1,tz='UTC'),selected,plan)
        final.append(p);final_rows.append(r);print(json.dumps(r),flush=True)
    baseline=pd.concat([pd.read_csv(p) for p in Path('data/monthly_backtest').glob('*_expanded_holiday_lgb_cqr.csv')])
    final_metrics=grouped_metrics(pd.concat(final));baseline_metrics=grouped_metrics(baseline)
    result.write_text(json.dumps(dict(selection=decision,final_selected=final_metrics,final_baseline=baseline_metrics,
        final_rows=final_rows,promoted=False,replay_changed=False,final_evaluations=1),indent=2),encoding='utf-8')
    print(json.dumps(dict(selected=selected,final_selected=final_metrics,final_baseline=baseline_metrics)),flush=True)


if __name__=='__main__':main()
