"""Bind monthly holiday models to existing predictions and past-only empirical confidence."""
import copy
import hashlib
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from pandas.tseries.holiday import USFederalHolidayCalendar
from src.data.adapter import adapt,config
from src.models.residual import ResidualForecaster
from src.conformal.replay_calibration import primitives,run
from scripts.monthly_backtest import split_month,measured
from scripts.search_byron import fit_quantiles

VERSION='byron-expanded-holiday-monthly-v1'


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def fit_confidence(pred):
    edges=np.linspace(0,1,11);centers=(edges[:-1]+edges[1:])/2
    bins=np.clip(np.digitize(pred.risk_score,edges)-1,0,9)
    counts=np.bincount(bins,minlength=10);hits=np.bincount(bins,weights=pred.hit.astype(int),minlength=10)
    keep=counts>0
    fit=IsotonicRegression(increasing=False,out_of_bounds='clip').fit(centers[keep],hits[keep]/counts[keep],sample_weight=counts[keep])
    values=fit.predict(centers)
    return dict(centers=centers.tolist(),coverage=values.tolist(),counts=counts.tolist(),hits=hits.tolist(),
        raw_coverage=[float(h/n) if n else None for h,n in zip(hits,counts)],
        definition='past-month out-of-sample interval coverage in risk deciles, weighted decreasing isotonic fit; not conditional guarantee')


def confidence(lookup,risk):
    return float(np.interp(risk,lookup['centers'],lookup['coverage']))


def main():
    index_path=Path('experiments/demo_monthly_index.json')
    if index_path.exists():raise FileExistsError('demo index immutable')
    cfg=config('configs/byron2017.yaml');cfg['conformal']['rejection_fraction']=.15
    cfg['features']['holidays']=USFederalHolidayCalendar().holidays('2016-01-01','2017-12-31').strftime('%Y-%m-%d').tolist()
    root=Path('data/raw/bdg2')
    raw=pd.read_csv(root/'electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron'])
    raw=raw[raw.timestamp>='2016-01-20 00:00:00'].rename(columns={'Hog_office_Byron':'meter_reading'})
    weather=pd.read_csv(root/'weather.csv',usecols=['timestamp','site_id','airTemperature','cloudCoverage'])
    weather=weather[weather.site_id.eq('Hog')].rename(columns={'airTemperature':'air_temperature','cloudCoverage':'cloud_coverage'})
    raw=raw.merge(weather.drop(columns='site_id'),on='timestamp',how='left',validate='one_to_one')
    raw['building_id']='Hog_office_Byron';raw['primary_use']='Office'
    data=adapt(raw,cfg);rows=[];past=[]
    # December2016 is an independent chronological warm-up validation for January confidence.
    for start in pd.date_range('2016-12-01','2017-12-01',freq='MS',tz='UTC'):
        train,cal,ev=split_month(data,start)
        model=ResidualForecaster(copy.deepcopy(cfg)).fit(train,cal);q=fit_quantiles(model,train)
        f=primitives(model,data[data.timestamp<start+pd.offsets.MonthBegin(1)])
        ct=sorted(cal.timestamp.unique());cq=f[f.timestamp.isin(ct[int(len(ct)*.65):])]
        evaluation=f[f.timestamp.isin(ev.timestamp)].sort_values('timestamp')
        pred=run(model,cq,evaluation,.15,'cqr',quantile_models=q)
        if start.year==2016:
            past.append(pred);continue
        month=start.strftime('%Y-%m')
        cached_path=Path(f'data/monthly_backtest/{month}_expanded_holiday_lgb_cqr.csv')
        cached=pd.read_csv(cached_path)
        for col in ('point','lower','upper','risk_score'):
            np.testing.assert_allclose(pred[col],cached[col],rtol=1e-9,atol=1e-7)
        assert np.array_equal(pred.abstain.to_numpy(),cached.abstain.to_numpy())
        validation=pd.concat(past,ignore_index=True)
        assert validation.timestamp.max()<start
        lookup=fit_confidence(validation)
        refs=[np.sort(np.asarray(v)) for v in model._components(cq,cq.scale.to_numpy())]
        crisk=sum(w*np.searchsorted(ref,v,side='right')/len(ref) for w,ref,v in zip(
            cfg['conformal']['risk_weights'],refs,model._components(cq,cq.scale.to_numpy())))
        threshold=float(np.quantile(crisk,.85,method='higher'))
        artifact=Path(f'models/{VERSION}-{month}.joblib')
        if artifact.exists():raise FileExistsError('do not overwrite artifact')
        bundle=dict(version=VERSION,month=month,backbone=model,quantile_models=q,calibration=cq,
            confidence_lookup=lookup,risk_threshold=threshold,confidence_threshold=confidence(lookup,threshold),
            confidence_validation_end=str(validation.timestamp.max()),train_end=str(train.timestamp.max()),
            calibration_end=str(cal.timestamp.max()),peak_load_threshold=float(train.y.quantile(.8)))
        joblib.dump(bundle,artifact)
        rows.append(dict(month=month,artifact=str(artifact),artifact_sha256=sha(artifact),
            predictions=str(cached_path),predictions_sha256=sha(cached_path),
            risk_threshold=threshold,confidence_threshold=bundle['confidence_threshold'],
            confidence_validation_end=bundle['confidence_validation_end'],confidence_lookup=lookup))
        past.append(pred)
    all_pred=pd.concat([pd.read_csv(r['predictions']) for r in rows],ignore_index=True)
    common=all_pred[pd.to_datetime(all_pred.timestamp,utc=True).dt.month>=4]
    result=dict(version=VERSION,rows=rows,pooled_full_year=measured(all_pred),pooled_apr_dec=measured(common),
        confidence_method='past-only risk-decile empirical interval coverage with isotonic smoothing',
        evaluation='rolling2017 pooled hourly predictions, historical reuse; not blind validation')
    index_path.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'full_year':result['pooled_full_year'],'apr_dec':result['pooled_apr_dec']},indent=2))


if __name__=='__main__':main()
