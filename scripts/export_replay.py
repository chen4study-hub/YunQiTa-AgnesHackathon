"""Export historical one-step test replay; no point model/threshold tuned on test."""
import json
import math
import hashlib
import joblib
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np
import pandas as pd
from jsonschema import Draft202012Validator
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.agent.dispatch import DATA_SOURCE, dispatch, score_confidence
from src.agent.confidence import gate_confidence

ROOT=Path('exports/replay')
REPLAY=config('configs/replay.yaml')
MAIN=REPLAY['main_building']
from scripts.replay_floor_allocation import floors,USES as FLOOR_USES
from scripts.export_future24 import load_sources,attach
def pv_sim(hour,cloud):
    if not np.isfinite(cloud): cloud=REPLAY['pv']['cloud_fallback']  # explicitly simulated medium-cloud fallback
    # No irradiance data: bell curve daylight proxy with cloud attenuation, not measured PV.
    daylight=max(0,math.sin(math.pi*(hour-6)/12))
    return round(REPLAY['pv']['capacity_kwp']*daylight*(1-.6*min(1,max(0,cloud/9))),1)


def verify_profile():
    provenance=json.loads(Path('experiments/replay_provenance.json').read_text(encoding='utf-8'))
    sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
    if sha(provenance['artifact'])!=provenance['artifact_sha256']:
        raise ValueError('replay artifact integrity failed')
    if sha('experiments/byron_selected_profiles.json')!=provenance['profile_selection_sha256']:
        raise ValueError('replay selection changed; regenerate explicit new version')
    key=str(REPLAY['rejection_fraction']);cached=provenance['caches'][key]
    if sha(cached['path'])!=cached['sha256']:
        raise ValueError('cached prediction integrity failed')
    if sha('data/byron2017.csv')!=provenance['data_sha256']:
        raise ValueError('input cohort changed')
    for prefix in ('campus_artifact','campus_input'):
        if sha(provenance[prefix])!=provenance[prefix+'_sha256']:
            raise ValueError('campus integrity failed: '+prefix)
    bundle=joblib.load(provenance['artifact'])
    if bundle['version']!=REPLAY['model_version'] or bundle['profiles'][key]['method']!=REPLAY['interval_method']:
        raise ValueError('replay method/version mismatch')
    return provenance


def predictions():
    verify_profile()
    cfg=config('configs/hog2017.yaml')
    frame=adapt(pd.read_csv('data/hog2017_cohort.csv'),cfg)
    model=ResidualForecaster.load('models/hog2017-v1.joblib')
    times=sorted(frame.timestamp.unique()); test_start=times[int(len(times)*.85)]
    p=model.predict(frame).frame
    x=frame.merge(p,on=['timestamp','building_id'],validate='one_to_one')
    x=x[x.timestamp>=test_start].copy()
    # Main tower uses a dedicated CQR profile selected solely on pilot validation.
    # Campus remains the frozen global candidate, not the online champion.
    main=pd.read_csv(f"data/byron_test_rejection_{int(REPLAY['rejection_fraction']*100)}.csv",parse_dates=['timestamp'])
    main['timestamp']=pd.to_datetime(main.timestamp,utc=True)
    cols=['timestamp','building_id','point','lower','upper','confidence','abstain','abstain_reason','risk_score']
    actual=frame[frame.building_id.eq(MAIN)]
    main=actual.merge(main[cols],on=['timestamp','building_id'],validate='one_to_one')
    x=pd.concat([x[~x.building_id.eq(MAIN)],main],ignore_index=True)
    return x,model,test_start


def choose_days(x):
    main=x[x.building_id.eq(MAIN)].copy()
    main['date']=main.timestamp.dt.strftime('%Y-%m-%d')
    dates=[]
    for day,g in main.groupby('date'):
        if len(g)!=24: continue
        dates.append({'date':day,'weekday':g.timestamp.dt.dayofweek.iloc[0]<5,
                      'rejected':int(g.abstain.sum()),'max_actual':float(g.y.max()),
                      'mean_actual':float(g.y.mean()),'max_temp':float(g.air_temperature.max()),
                      'mean_risk':float(g.risk_score.mean())})
    candidates=pd.DataFrame(dates)
    normal=candidates[(candidates.weekday)&(candidates.rejected<=2)].sort_values(['rejected','mean_risk','date']).iloc[0]
    peak=candidates[candidates.date.ne(normal.date)].sort_values(['max_actual','date'],ascending=[False,True]).iloc[0]
    abstain=candidates[~candidates.date.isin([normal.date,peak.date])].sort_values(['rejected','mean_risk','date'],ascending=[False,False,True]).iloc[0]
    return {'normal':normal.to_dict(),'peak':peak.to_dict(),'abstain':abstain.to_dict()}


def monthly_peak_threshold(month):
    index=json.loads(Path('experiments/demo_monthly_index.json').read_text(encoding='utf-8'))
    item=next(r for r in index['rows'] if r['month']==month)
    return joblib.load(item['artifact'])['peak_load_threshold']


def choose_monthly_days(x):
    days=[]
    for day,g in x.groupby(x.timestamp.dt.strftime('%Y-%m-%d')):
        if len(g)!=24:continue
        days.append(dict(date=day,month=g.timestamp.dt.month.iloc[0],weekday=g.timestamp.dt.dayofweek.iloc[0]<5,
            holiday=bool(g.holiday.iloc[0]),rejected=int(g.abstain.sum()),mean_load=float(g.y.mean()),
            max_load=float(g.y.max()),max_temp=float(g.air_temperature.max()),
            afternoon_dispatch=bool(((g.timestamp.dt.hour>=12)&(g.timestamp.dt.hour<18)&~g.abstain &
                (g.point>monthly_peak_threshold(day[:7]))).any())))
    d=pd.DataFrame(days)
    summer=d[d.month.isin([7,8]) & d.weekday & ~d.holiday].copy()
    summer=summer[(summer.max_temp>=30) & (summer.max_load>=summer.max_load.quantile(.75)) & summer.afternoon_dispatch]
    if summer.empty:raise ValueError('No hot high-load workday with accepted afternoon discharge')
    peak=summer.sort_values(['rejected','max_load','max_temp','date'],ascending=[True,False,False,True]).iloc[0]
    ordinary=d[d.month.isin([3,4,5,9,10,11]) & d.weekday & ~d.holiday].copy()
    ordinary['distance']=(ordinary.mean_load-ordinary.mean_load.median()).abs()
    normal=ordinary.sort_values(['rejected','distance','date']).iloc[0]
    holidays=d[d.holiday & (d.rejected>0) & (d.rejected<24)].copy()
    holidays['ten_refused']=[bool(x[(x.timestamp.dt.strftime('%Y-%m-%d')==day)&(x.timestamp.dt.hour==10)].abstain.iloc[0]) for day in holidays.date]
    holidays['named_priority']=holidays.date.isin(['2017-07-04','2017-11-23']).astype(int)
    abstain=holidays.sort_values(['ten_refused','named_priority','rejected','date'],ascending=[False,False,False,True]).iloc[0]
    return {k:r.to_dict() for k,r in [('normal',normal),('peak',peak),('abstain',abstain)]}


def export():
    index=json.loads(Path('experiments/demo_monthly_index.json').read_text(encoding='utf-8'))
    predictions_all=[]
    for item in index['rows']:
        if hashlib.sha256(Path(item['predictions']).read_bytes()).hexdigest()!=item['predictions_sha256']:
            raise ValueError('monthly prediction integrity failed')
        daily_path=Path('experiments/round78_calibration.json')
        daily=json.loads(daily_path.read_text()) if daily_path.exists() else None
        source=next(r for r in daily['rows'] if r['month']==item['month']) if daily else None
        if source and hashlib.sha256(Path(source['one_path']).read_bytes()).hexdigest()!=source['one_sha256']:raise ValueError('daily cache integrity failed')
        predictions_all.append(pd.read_csv(source['one_path'] if source else item['predictions'],parse_dates=['timestamp']))
    main=pd.concat(predictions_all,ignore_index=True)
    main['timestamp']=pd.to_datetime(main.timestamp,utc=True)
    weather=pd.read_csv('data/byron2017.csv')
    weather['timestamp']=pd.to_datetime(weather.timestamp,utc=True)
    x=main.merge(weather[['timestamp','air_temperature','cloud_coverage']],on='timestamp',validate='one_to_one')
    picks=choose_monthly_days(x)
    test_start=x.timestamp.min()
    meta=pd.read_csv('data/raw/bdg2/metadata.csv').set_index('building_id')
    # Base generation is a legacy intermediate; final Agent exporter emits 1.5.
    schema=json.loads(Path('contracts/replay-1.4.schema.json').read_text(encoding='utf-8'))
    validator=Draft202012Validator(schema,format_checker=Draft202012Validator.FORMAT_CHECKER)
    ROOT.mkdir(parents=True,exist_ok=True)
    entries=[]
    future_sources=load_sources()
    thresholds_by_scenario={}
    for scenario,selection in picks.items():
        day=selection['date']
        item=next(r for r in index['rows'] if r['month']==day[:7])
        if hashlib.sha256(Path(item['artifact']).read_bytes()).hexdigest()!=item['artifact_sha256']:
            raise ValueError('monthly artifact integrity failed')
        bundle=joblib.load(item['artifact']);risk_threshold=bundle['risk_threshold']
        peak_threshold=bundle['peak_load_threshold']
        thresholds_by_scenario[scenario]=dict(month=day[:7],threshold=peak_threshold,train_end=bundle['train_end'])
        df=x[x.timestamp.dt.strftime('%Y-%m-%d').eq(day)].copy()
        # Campus has its own causal monthly global model; never reuse a future-trained November model.
        from scripts.monthly_backtest import split_month
        campus_frame=adapt(pd.read_csv('data/hog2017_cohort.csv'),config('configs/hog2017.yaml'))
        month_start=pd.Timestamp(day[:7]+'-01',tz='UTC')
        train,cal,ev=split_month(campus_frame,month_start)
        campus_model=ResidualForecaster(config('configs/hog2017.yaml')).fit(train,cal)
        cp=campus_model.predict(campus_frame[campus_frame.timestamp<month_start+pd.offsets.MonthBegin(1)]).frame
        cp=cp[(cp.timestamp.dt.strftime('%Y-%m-%d')==day)&~cp.building_id.eq(MAIN)]
        df=pd.concat([df,cp],ignore_index=True)
        b=df[df.building_id.eq(MAIN)].sort_values('timestamp')
        if len(b)!=24: raise ValueError('main day incomplete')
        hours=[]; s=REPLAY['storage']; soc=s['initial_soc']
        for row in b.itertuples():
            hour=row.timestamp.hour
            abstain=bool(row.abstain)
            current_risk_threshold=float(row.risk_threshold) if daily else risk_threshold
            displayed_confidence,confidence_threshold=gate_confidence(bundle['confidence_lookup'],row.risk_score,current_risk_threshold,abstain)
            # Rule-only shadow simulation. No dispatch is issued to hardware.
            power=0.0
            if not abstain and scenario=='peak' and 12<=hour<18 and row.point>peak_threshold:
                power=min(s['discharge_kw'],s['max_power_kw'],max(0.,(soc-s['min_soc'])*s['capacity_kwh']))
            elif not abstain and scenario=='peak' and 0<=hour<6:
                power=-min(s['charge_kw'],s['max_power_kw'],max(0.,(s['max_soc']-soc)*s['capacity_kwh']))
            soc=round(max(s['min_soc'],min(s['max_soc'],soc-power/s['capacity_kwh'])),4)
            pv=pv_sim(hour,row.cloud_coverage if pd.notna(row.cloud_coverage) else float('nan'))
            point=round(float(row.point),1)
            fl=floors(point,hour,day)
            actions=[] if abstain else ([f'储能{("放电" if power>0 else "充电")} {abs(power):.1f} kW'] if power else ['维持 24 °C 设定值'])
            dispatch({'scenario':scenario,'t':str(row.timestamp),'status':'handoff' if abstain else 'executed',
                      'risk_score':float(row.risk_score),'risk_threshold':risk_threshold,'actions':actions})
            hours.append({'t':row.timestamp.to_pydatetime().replace(tzinfo=ZoneInfo(REPLAY['timezone'])).isoformat(),
                'actual_kw':round(float(row.y),1),'point_kw':point,
                'lower_kw':round(float(row.lower),1),'upper_kw':round(float(row.upper),1),
                'confidence':displayed_confidence,'risk_score':float(row.risk_score),
                'risk_threshold':current_risk_threshold,'abstain':abstain,
                'abstain_reason':str(row.abstain_reason) if abstain else None,
                'outdoor_temp_c':round(float(row.air_temperature),1) if pd.notna(row.air_temperature) else None,
                'floors_kw':fl,'storage':{'power_kw':round(power,1),'soc':round(soc,3)},
                'pv':{'power_kw':pv},'grid_kw':round(max(0,round(float(row.y),1)-round(power,1)-pv),1),
                'agent':{'status':'handoff' if abstain else 'executed','source':'rule',
                         'hvac_setpoint_c':24.,'actions':actions,
                         'explanation':('风险超过门控或区间过宽，转交人工。' if abstain else
                                        '置信评分通过门控，指令已下发至dispatch日志。')}})
        campus=[]
        for bid,g in df[~df.building_id.eq(MAIN)].groupby('building_id'):
            g=g.sort_values('timestamp')
            if len(g)!=24: continue
            area=meta.loc[bid,'sqm']
            campus.append({'building_id':bid,'primary_use':str(meta.loc[bid,'primaryspaceusage']),
                'sqm':round(float(area),1) if pd.notna(area) else None,
                'hourly':[{'point_kw':round(float(r.point),1),'abstain':bool(r.abstain)} for r in g.itertuples()]})
        title={'normal':'普通工作日','peak':'高负荷日','abstain':'高拒绝日'}[scenario]
        data={'schema_version':'1.2','meta':{'scenario':scenario,'title':title,'date':day,
            'building_id':MAIN,'display_name':'云栖塔','sqm':80038.2,'floors':40,
            'floors_source':'estimated_from_area','floor_uses':FLOOR_USES,'alpha':.095,
            'model_version':REPLAY['model_version'],'operating_point':REPLAY['operating_point'],'mode':'auto','data_source':DATA_SOURCE,'confidence_threshold':confidence_threshold,
            'units':{'power':'kW','temperature':'°C'},'simulated_fields':['storage','pv','grid_kw'],
            'estimated_fields':['floors_kw']},'hours':hours,'campus':campus}
        data=attach(data,future_sources)
        validator.validate(data)
        path=ROOT/f'{scenario}.json';path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False),encoding='utf-8')
        if path.stat().st_size>2_000_000: raise ValueError('replay exceeds 2MB')
        entries.append({'scenario':scenario,'title':title,'date':day,'building_id':MAIN,
                        'model_version':REPLAY['model_version'],'mode':'auto'})
    (ROOT/'index.json').write_text(json.dumps(entries,ensure_ascii=False,indent=2),encoding='utf-8')
    provenance={'test_start':str(test_start),'scenarios':picks,'campus_buildings':len(campus),
                'peak_threshold_from_train':thresholds_by_scenario['peak']['threshold'],
                'peak_threshold_by_scenario':thresholds_by_scenario,'main_profile':f"CQR validation-selected, rho={REPLAY['rejection_fraction']}",
                'campus_model':'Hog global monthly past-only recalibration','demo_model':index['version'],'champion_updated':False,
                'selection_rules':'peak Jul/Aug nonholiday weekday Tmax>=30C and upper-quartile maximum load, accepted afternoon load above past-trainP80; fewest rejected hours then load/temp/date; normal spring/autumn weekday near seasonal median load with fewest rejects; abstain actual federal observed date with1-23refusals, prefer10h refusal, then Independence/Thanksgiving, then most refused hours, earliest date',
                'confidence':'99% past-only empirical isotonic coverage +1% inverse risk tie-break; full-gate rejection penalty; display score not coverage probability'}
    Path('experiments/replay_selection.json').write_text(json.dumps(provenance,indent=2,default=lambda v:bool(v) if isinstance(v,np.bool_) else v),encoding='utf-8')
    print(json.dumps(provenance,indent=2,default=lambda v:bool(v) if isinstance(v,np.bool_) else v))
    return picks


if __name__=='__main__': export()
