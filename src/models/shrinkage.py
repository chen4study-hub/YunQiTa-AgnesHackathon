"""Pickle-safe fixed residual shrinkage wrapper for exploratory forecasters."""
class ScaledResidual:
    def __init__(self,model,factor):
        if not 0<=factor<=1:raise ValueError('factor must lie in [0,1]')
        self.model=model
        self.factor=factor

    def predict(self,features):
        return self.factor*self.model.predict(features)


class WeatherOODResidual:
    """Shrink only where lagged weather lies outside the training support."""
    def __init__(self,model,weather_column,lower,upper,factor=.5):
        if not 0<=factor<=1:raise ValueError('factor must lie in [0,1]')
        self.model=model;self.weather_column=weather_column
        self.lower=lower;self.upper=upper;self.factor=factor

    def predict(self,features):
        import numpy as np
        weather=features[self.weather_column]
        ood=(weather<self.lower)|(weather>self.upper)
        return np.where(ood,self.factor,1.)*self.model.predict(features)
