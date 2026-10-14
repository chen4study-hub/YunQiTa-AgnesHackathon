import numpy as np
import pandas as pd
from src.conformal.rolling_cqr import run_rolling_cqr


class Quantile:
    def __init__(self,value):self.value=value
    def predict(self,x):return np.full(len(x),self.value)


class Model:
    columns=['lag_1']
    cfg={'conformal':{'alpha':.095,'risk_weights':[1,0,0,0],'max_relative_width':100}}
    def _components(self,f,scale):return [scale,np.ones(len(f)),np.ones(len(f)),np.ones(len(f))]


def test_rolling_cqr_current_and_future_actual_do_not_change_issued_bounds():
    times=pd.date_range('2017-01-01',periods=160,freq='h',tz='UTC')
    frame=pd.DataFrame(dict(timestamp=times,building_id='A',lag_1=10.,point=10.,y=10.,scale=1.))
    cq=frame.iloc[:100];ev=frame.iloc[100:].copy()
    changed=ev.copy();changed.loc[changed.index[30]:,'y']=10000.
    q=(Quantile(-1.),Quantile(1.))
    a=run_rolling_cqr(Model(),cq,ev,.15,q)
    b=run_rolling_cqr(Model(),cq,changed,.15,q)
    np.testing.assert_allclose(a.iloc[:31][['lower','upper']],b.iloc[:31][['lower','upper']])
    assert (a.lower<=a.point).all() and (a.upper>=a.point).all()
    assert b.iloc[-1].upper>a.iloc[-1].upper
