"""Point, interval and risk-coverage measures, with explicit denominators."""
import numpy as np


def evaluate(y, prediction, capacity=None):
    y = np.asarray(y, dtype=float)
    p = prediction.frame
    point = p.point.to_numpy(dtype=float)
    retained = ~p.abstain.to_numpy(dtype=bool)
    if not len(y) or len(y) != len(p) or not retained.any():
        raise ValueError('nonempty aligned observations with retained predictions required')
    error = point - y
    rmse = float(np.sqrt(np.mean(error ** 2)))
    mean_y = float(y.mean())
    width = p.upper.to_numpy() - p.lower.to_numpy()
    denom = capacity if capacity is not None else float(y.max() - y.min())
    # ASHRAE Guideline 14-style CV(RMSE), NMBE use mean metered y; no parameter adjustment.
    # PINAW denominator defaults to observed test range; record this choice when comparing studies.
    return dict(mae=float(np.mean(np.abs(error))), rmse=rmse,
        cv_rmse=None if mean_y == 0 else 100 * rmse / mean_y,
        nmbe=None if mean_y == 0 else 100 * float(np.mean(y - point)) / mean_y,
        picp=float(np.mean((y >= p.lower.to_numpy()) & (y <= p.upper.to_numpy()))),
        pinaw=None if denom <= 0 else float(np.mean(width) / denom),
        rejection_rate=float(np.mean(~retained)),
        retained_mae=float(np.mean(np.abs(error[retained]))),
        retained_rmse=float(np.sqrt(np.mean(error[retained] ** 2))),
        retained_picp=float(np.mean((y[retained] >= p.lower.to_numpy()[retained]) &
                                        (y[retained] <= p.upper.to_numpy()[retained]))))


def risk_coverage(y, prediction, budgets=(0, 0.1, 0.2, 0.3)):
    p = prediction.frame
    score = p.risk_score.to_numpy() if 'risk_score' in p else (p.upper - p.lower).to_numpy()
    errors = np.abs(np.asarray(y) - p.point.to_numpy())
    order = np.argsort(score, kind='stable')
    return [{'coverage': 1 - b, 'risk_mae': float(np.mean(errors[order[:max(1, int(len(order) * (1-b)))]]))}
            for b in budgets]
