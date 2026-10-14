"""Frozen source model; vary target B calibration history, hold target test fixed."""
import json
import numpy as np
import pandas as pd
from src.data.adapter import adapt, config
from src.models.residual import ResidualForecaster
from src.metrics import evaluate
from src.models.base import ForecastResult


def run():
    c=config(); f=adapt(pd.read_csv('data/bdg2_cohort.csv'),c)
    times=sorted(f.timestamp.unique()); a,b=int(len(times)*.65),int(len(times)*.85)
    target=f[f.building_id.eq('Robin_education_Billi')]
    source=f[~f.building_id.eq('Robin_education_Billi')]
    model=ResidualForecaster(c).fit(source[source.timestamp.isin(times[:a])],source[source.timestamp.isin(times[a:b])])
    frozen_point=model.point_model.booster_.model_to_string()
    frozen_scale=model.scale_model.booster_.model_to_string()
    test=target[target.timestamp.isin(times[b:])]
    rows=[]
    for weeks in (1,2,4,10):
        # All windows end at same calibration boundary, no target test labels.
        cutoff=times[b]-pd.Timedelta(weeks=weeks)
        history=target[(target.timestamp >= cutoff)&(target.timestamp < times[b])]
        # Include earlier context only for lag construction, but calibrate on last N weeks.
        context=target[(target.timestamp >= cutoff-pd.Timedelta(hours=168)) & (target.timestamp < times[b])]
        model.recalibrate(context)
        pred=model.predict(target).frame
        pred=pred[pred.timestamp.isin(times[b:])].reset_index(drop=True)
        truth=test.merge(pred[['building_id','timestamp']],on=['building_id','timestamp'])
        stats=evaluate(truth.y.to_numpy(),ForecastResult(pred))
        rows.append({'weeks':weeks,'calibration_hours_requested':len(history),'calibration_hours_eligible':max(0,len(context)-168),
                     'rejection_rate':stats['rejection_rate'],'retained_picp':stats['retained_picp'],
                     'retained_mae':stats['retained_mae'],'picp':stats['picp']})
        assert model.point_model.booster_.model_to_string()==frozen_point
        assert model.scale_model.booster_.model_to_string()==frozen_scale
    return rows


if __name__=='__main__':
    rows=run();print(json.dumps(rows,indent=2));pd.DataFrame(rows).to_csv('experiments/transfer_curve.csv',index=False)
