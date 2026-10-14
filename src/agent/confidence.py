"""Empirical coverage-backed display score aligned to the complete rejection gate."""
import numpy as np


def calibrated_score(lookup,risk):
    risk=float(np.clip(risk,0,1))
    empirical=float(np.interp(risk,lookup['centers'],lookup['coverage']))
    # Small strictly decreasing tie-break prevents isotonic plateaus from hiding risk.
    return float(.99*empirical+.01*(1-risk))


def gate_confidence(lookup,risk,risk_threshold,abstain):
    threshold=round(calibrated_score(lookup,risk_threshold),12)
    value=calibrated_score(lookup,risk)
    if abstain:
        # Width rejection may occur below the risk threshold; encode that complete gate.
        value=min(value,threshold-1e-6-.001*(1-float(risk)))
    else:
        if float(risk)>float(risk_threshold):
            raise ValueError('Accepted risk cannot exceed the frozen threshold')
        value=max(value,threshold)
    return round(float(np.clip(value,0,1)),12),threshold
