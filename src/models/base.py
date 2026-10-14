"""Stable model protocol and typed forecast rows."""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ForecastResult:
    frame: object  # pandas DataFrame with canonical timestamp/point/lower/upper/confidence/abstain/reason


class Forecaster(ABC):
    @abstractmethod
    def fit(self, train_df, calib_df): ...

    @abstractmethod
    def predict(self, df) -> ForecastResult: ...

    @abstractmethod
    def recalibrate(self, calib_df): ...

    @abstractmethod
    def save(self, path: str | Path): ...

    @classmethod
    @abstractmethod
    def load(cls, path: str | Path): ...
