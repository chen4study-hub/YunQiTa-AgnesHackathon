import numpy as np
import pandas as pd
import pytest
from src.models.shrinkage import ScaledResidual, WeatherOODResidual


class FixedResidual:
    def predict(self,x):return np.full(len(x),20.)


def test_weather_ood_wrapper_uses_only_lagged_training_bounds():
    frame=pd.DataFrame({'air_temperature_past':[-1.,0.,10.,20.,21.,np.nan],'y':100.})
    model=WeatherOODResidual(FixedResidual(),'air_temperature_past',0.,20.,.5)
    np.testing.assert_allclose(model.predict(frame),[10.,20.,20.,20.,10.,20.])
    changed=frame.copy();changed['y']=99999.
    np.testing.assert_allclose(model.predict(frame),model.predict(changed))


def test_residual_wrappers_validate_fixed_factor():
    x=pd.DataFrame({'a':[1,2]})
    np.testing.assert_allclose(ScaledResidual(FixedResidual(),.5).predict(x),[10.,10.])
    with pytest.raises(ValueError):ScaledResidual(FixedResidual(),1.1)
    with pytest.raises(ValueError):WeatherOODResidual(FixedResidual(),'a',0,20,-.1)
