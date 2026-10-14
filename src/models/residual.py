"""Residual LightGBM + normalized split conformal + selective routing."""
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from .base import Forecaster, ForecastResult
from src.features.build import build
from src.conformal.selective import fit_routing, apply_routing


class ResidualForecaster(Forecaster):
    def __init__(self, cfg):
        if cfg['features']['horizon_hours'] != 1:
            raise ValueError('only causally safe 1-step forecast is implemented')
        self.cfg = cfg
        self.point_model = None
        self.scale_model = None
        self.columns = None

    def _matrix(self, frame):
        f, columns = build(frame, self.cfg)
        if self.columns is not None and columns != self.columns:
            # Missing optional weather is represented as NA rather than changing schema.
            for col in self.columns:
                if col not in f:
                    f[col] = np.nan
            columns = self.columns
        return f, columns

    def _point(self, f):
        return np.maximum(0, f.lag_1.to_numpy() + self.point_model.predict(f[self.columns]))

    def _components(self, f, scale):
        building = f.building_id.map(self.building_risk).fillna(self.global_risk).to_numpy()
        usage = f.usage.map(self.usage_risk).fillna(self.global_risk).to_numpy()
        return [scale, f.disagreement.to_numpy(), building, usage]

    def fit(self, train_df, calib_df):
        train, cols = build(train_df, self.cfg)
        self.columns = cols
        if train.empty or train.y.isna().any():
            raise ValueError('train needs full observed history and target')
        if train_df.timestamp.max() >= calib_df.timestamp.min():
            raise ValueError('train/calibration chronology overlaps')
        kw = self.cfg['model']
        options = dict(n_estimators=kw['n_estimators'], learning_rate=kw['learning_rate'],
                       num_leaves=kw['num_leaves'], random_state=self.cfg['seed'],
                       verbosity=-1, n_jobs=2)
        self.point_model = LGBMRegressor(**options)
        self.point_model.fit(train[cols], train.y - train.lag_1)
        residual = np.abs(train.y.to_numpy() - self._point(train))
        train = train.assign(abs_error=residual)
        self.global_risk = float(np.mean(residual))
        self.building_risk = train.groupby('building_id').abs_error.mean().to_dict()
        self.usage_risk = train.groupby('usage').abs_error.mean().to_dict()
        # Scale training uses only first 65% of the independent calibration period.
        self.train_history = train_df.groupby('building_id', sort=False).tail(max(self.cfg['features']['lags']) + 1).copy()
        self.recalibrate(calib_df, fit_scale=True)
        del self.train_history
        return self

    def recalibrate(self, calib_df, fit_scale=False):
        if self.point_model is None:
            raise ValueError('fit model before recalibration')
        # Historical lags at the split boundary come from training, never from future.
        source = pd.concat([self.train_history, calib_df], ignore_index=True) if fit_scale else calib_df
        f, _ = self._matrix(source)
        f = f.merge(calib_df[['building_id', 'timestamp']], on=['building_id', 'timestamp'], how='inner')
        if len(f) < 20 or f.y.isna().any():
            raise ValueError('calibration needs at least 20 eligible observed rows')
        if fit_scale:
            # Split by timestamp, not rows (avoids splitting a shared hour among buildings).
            times = np.sort(f.timestamp.unique())
            n = int(len(times) * self.cfg['conformal']['scale_fraction'])
            if n < 1 or n == len(times):
                raise ValueError('calibration span too short')
            scale_rows = f[f.timestamp.isin(times[:n])]
            q_rows = f[f.timestamp.isin(times[n:])]
            kw = self.cfg['model']
            self.scale_model = LGBMRegressor(n_estimators=kw['n_estimators'],
                learning_rate=kw['learning_rate'], num_leaves=kw['num_leaves'],
                random_state=self.cfg['seed'], verbosity=-1, n_jobs=2)
            self.scale_model.fit(scale_rows[self.columns],
                np.abs(scale_rows.y.to_numpy() - self._point(scale_rows)))
        else:
            if self.scale_model is None:
                raise ValueError('no fitted scale model')
            # Local transfer: all target-building calibration observations are C_q;
            # never refit point or scale models.
            q_rows = f
        scale = np.maximum(self.cfg['conformal']['min_scale'],
                           self.scale_model.predict(q_rows[self.columns]))
        scores = np.abs(q_rows.y.to_numpy() - self._point(q_rows)) / scale
        self.refs, self.threshold, self.multiplier = fit_routing(
            self._components(q_rows, scale), scores, self.cfg['conformal'])
        return self

    def predict(self, df):
        if self.scale_model is None or not hasattr(self, 'threshold'):
            raise ValueError('model not calibrated')
        f, _ = self._matrix(df)
        if f.empty:
            raise ValueError('insufficient known lag history')
        point = self._point(f)
        scale = np.maximum(self.cfg['conformal']['min_scale'],
                           self.scale_model.predict(f[self.columns]))
        risk_score, abstain = apply_routing(self.refs, self._components(f, scale),
                                  self.threshold, self.cfg['conformal']['risk_weights'])
        low = np.maximum(0, point - self.multiplier * scale)
        high = point + self.multiplier * scale
        wide = (high - low) / np.maximum(point, 1) > self.cfg['conformal']['max_relative_width']
        reason = np.where(abstain, 'routing_risk_above_threshold',
                          np.where(wide, 'interval_too_wide', None))
        return ForecastResult(pd.DataFrame(dict(timestamp=f.timestamp, building_id=f.building_id,
            point=point, lower=low, upper=high,
            confidence=1 - self.cfg['conformal']['alpha'],
            abstain=abstain | wide, abstain_reason=reason, risk_score=risk_score)).reset_index(drop=True))

    def save(self, path):
        if self.scale_model is None:
            raise ValueError('unfitted')
        joblib.dump(self, Path(path))

    @classmethod
    def load(cls, path):
        instance = joblib.load(Path(path))  # trusted local artifacts only, never user uploads
        if not isinstance(instance, cls):
            raise TypeError('unexpected artifact')
        return instance
