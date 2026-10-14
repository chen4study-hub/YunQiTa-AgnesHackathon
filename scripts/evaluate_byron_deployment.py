"""Foreground serial deployment replay; frozen artifacts, new calibration only."""
import os
for key in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):os.environ[key]='1'
import hashlib,json,time,copy
from pathlib import Path
import joblib,numpy as np,pandas as pd
from src.conformal.byron_daily import calibration_state,issued,multi_primitives,daily_multi,BUILDING,VERSION
from src.conformal.daily_local import prepare,metrics
from src.models.shortfix_multi import features
from scripts.research_holiday_calibration import load_data

ROOT=Path('data/deployment_daily')
RECEIPT=Path('experiments/round78_calibration.json')


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def run():
    if RECEIPT.exists():raise FileExistsError('deployment calibration already evaluated')
    ROOT.mkdir(exist_ok=True);(ROOT/'.gitignore').write_text('*.csv\n',encoding='utf-8')
    data=load_data();assert data.building_id.eq(BUILDING).all()
    monthly=json.loads(Path('experiments/demo_monthly_index.json').read_text())
    multi=json.loads(Path('experiments/multi_horizon_v3_index.json').read_text())
    allone=[];allmulti=[];rows=[];started=time.monotonic();ff=features(data)
    blank=data.iloc[-1:].copy();blank['timestamp']=data.timestamp.max()+pd.Timedelta(hours=1);blank['y']=np.nan;blank['air_temperature']=np.nan
    one_data=pd.concat([data,blank],ignore_index=True)
    for item in monthly['rows']:
        month=item['month'];start=pd.Timestamp(month+'-01',tz='UTC');end=start+pd.offsets.MonthBegin(1)
        assert sha(item['artifact'])==item['artifact_sha256'];bundle=joblib.load(item['artifact'])
        for m in [bundle['backbone'].point_model,bundle['backbone'].scale_model,*bundle['quantile_models']]:m.set_params(n_jobs=1)
        cfg=copy.deepcopy(bundle['backbone'].cfg['conformal']);cfg['rejection_fraction']=.15
        f=prepare(bundle['backbone'],one_data[one_data.timestamp<end+pd.Timedelta(hours=1)],bundle['quantile_models'])
        # Include next-month00 target for previous day's h1, but fit on previous origin day.
        one=[];h1=[]
        for day in pd.date_range(start,end-pd.Timedelta(days=1),freq='D'):
            state=calibration_state(f,day,cfg,bundle['train_end'])
            ev=f[(f.timestamp>=day)&(f.timestamp<day+pd.Timedelta(days=1))]
            p=issued(ev,state,cfg,bundle['confidence_lookup']);p['y']=ev.y.to_numpy();p['hit']=(p.y>=p.lower)&(p.y<=p.upper);one.append(p)
            ev=f[(f.timestamp>day)&(f.timestamp<=day+pd.Timedelta(days=1))]
            p=issued(ev,state,cfg,bundle['confidence_lookup']);p['origin']=p.timestamp-pd.Timedelta(hours=1);p['target']=p.timestamp;p['horizon']=1
            p['y']=ev.y.to_numpy();p['hit']=(p.y>=p.lower)&(p.y<=p.upper);assert (p.cal_end<p.origin.dt.floor('D')).all();h1.append(p)
        p=pd.concat(one,ignore_index=True);old=pd.read_csv(f'data/calibration_v1/byron_{month}_daily_10d.csv')
        for col in ['point','lower','upper','risk_score','threshold']:np.testing.assert_allclose(p[col],old[col],rtol=1e-9,atol=1e-7)
        assert np.array_equal(p.abstain,old.abstain)
        path=ROOT/(month+'_one.csv');p.to_csv(path,index=False);allone.append(p)
        mi=next(r for r in multi['rows'] if r['month']==month);assert sha(mi['artifact'])==mi['artifact_sha256'];mb=joblib.load(mi['artifact'])
        subset=ff[(ff.origin>=start-pd.Timedelta(days=11))&(ff.origin<end)]
        raw=multi_primitives(mb,subset);mp=daily_multi(raw,start,end,mb['confidence_lookup'])
        mp=pd.concat([pd.concat(h1,ignore_index=True),mp],ignore_index=True).sort_values(['origin','horizon'])
        oldmulti=pd.read_csv(mi['predictions']);np.testing.assert_allclose(mp.point,oldmulti.point,rtol=1e-9,atol=1e-7)
        assert (mp.cal_end<pd.to_datetime(mp.origin,utc=True).dt.floor('D')).all()
        pathmulti=ROOT/(month+'_multi.csv');mp.to_csv(pathmulti,index=False);allmulti.append(mp)
        rows.append(dict(month=month,one_path=str(path),one_sha256=sha(path),multi_path=str(pathmulti),multi_sha256=sha(pathmulti),
                         one_artifact_sha256=item['artifact_sha256'],multi_artifact_sha256=mi['artifact_sha256'],min_cal_rows=int(mp.cal_n.min()),
                         one_metrics=metrics(p),multi_refused=int(mp.abstain.sum())))
        print(json.dumps(rows[-1]),flush=True)
    one=pd.concat(allone,ignore_index=True);mp=pd.concat(allmulti,ignore_index=True)
    original=json.loads(Path('experiments/calibration_v1/byron_results.json').read_text())
    m=metrics(one);assert m==original['pooled']['daily_10d']
    assert len(one)==8760 and one.timestamp.nunique()==8760
    def safe_metrics(g):return metrics(g[g.y.notna()])
    stats=[dict(horizon=int(h),**safe_metrics(g)) for h,g in mp.groupby('horizon')]
    april=one[pd.to_datetime(one.timestamp,utc=True).dt.month>=4]
    receipt=dict(status='passed',version=VERSION,building=BUILDING,days=10,min_rows=120,rows=rows,pooled=m,april_dec=metrics(april),
                 baseline_pooled=original['pooled']['monthly'],multi_metrics=stats,foreground=True,single_thread=True,seconds=time.monotonic()-started,
                 unchanged_point=True,cold_start_enabled=False,assert_no_today_labels=True,
                 calibration_clock='UTC source-day labels; source wall hour preserved on export; cross-midnight horizons fit on origin day',
                 confidence='unchanged past-only monthly empirical lookup applied to new risk and complete gate; not a probability guarantee')
    RECEIPT.write_text(json.dumps(receipt,indent=2,allow_nan=False),encoding='utf-8');print(json.dumps({k:v for k,v in receipt.items() if k not in ['rows','multi_metrics']}))


if __name__=='__main__':run()
