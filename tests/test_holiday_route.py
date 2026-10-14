import os
from pathlib import Path
import joblib
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from src.api import app as api


def test_byron_actual_predict_uses_calendar_bundle(tmp_path,monkeypatch):
    artifact=api.ROOT/'models/byron-expanded-holiday-monthly-v1-2017-10.joblib'
    data=api.ROOT/'data/byron2016_2017_holiday_development.csv'
    if not artifact.exists() or not data.exists():pytest.skip('Local holiday data/models required')
    bundle=joblib.load(artifact);model=bundle['backbone']
    assert 'holiday' in model.columns and model.cfg['features']['holidays']
    target=pd.Timestamp('2017-10-09T12:00:00Z')
    history=pd.read_csv(data);history['timestamp']=pd.to_datetime(history.timestamp,utc=True)
    history=history[history.timestamp<target]
    # Clean data's y column maps back to the frozen observation adapter contract.
    history=history.rename(columns={'y':'meter_reading','usage':'primary_use'})
    csv=tmp_path/'history.csv';history.to_csv(csv,index=False)
    monkeypatch.setenv('BUILDING_DATA_CSV',str(csv))
    future=history.iloc[[-1]].copy();future['timestamp']=target;future['meter_reading']=float('nan')
    from src.data.adapter import adapt
    feature,_=model._matrix(adapt(pd.concat([history,future],ignore_index=True),model.cfg))
    assert feature.loc[feature.timestamp.eq(target),'holiday'].iloc[0]==1
    client=TestClient(api.app)
    req={'building_id':'Hog_office_Byron','start':target.isoformat(),'end':(target+pd.Timedelta(hours=1)).isoformat()}
    response=client.post('/predict',json=req)
    assert response.status_code==200,response.text
    assert response.json()['model_version']=='byron-expanded-holiday-monthly-v1'
    assert len(response.json()['predictions'])==1
    assert client.post('/schedule',json=req).json()['mode']=='auto'
