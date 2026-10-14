"""Paper-inspired fixed-budget selection, empirical after-selection coverage only."""
import math
import numpy as np


def percentile(reference, values):
    ordered = np.sort(np.asarray(reference, dtype=float))
    return np.searchsorted(ordered, np.asarray(values, dtype=float), side='right') / len(ordered)


def finite_quantile(scores, alpha):
    a = np.sort(np.asarray(scores, dtype=float))
    if not len(a) or not np.isfinite(a).all():
        raise ValueError('empty/nonfinite conformal scores')
    k = min(len(a), math.ceil((len(a) + 1) * (1 - alpha)))
    return float(a[k - 1])


def fit_routing(components, scores, cfg):
    weights = np.asarray(cfg['risk_weights'], dtype=float)
    if len(weights) != len(components) or not np.isclose(weights.sum(), 1):
        raise ValueError('risk weights must sum to one')
    refs = [np.sort(np.asarray(c, dtype=float)) for c in components]
    if any(not len(c) or not np.isfinite(c).all() for c in refs):
        raise ValueError('invalid routing calibration')
    risk = sum(w * percentile(ref, comp) for w, ref, comp in zip(weights, refs, components))
    # Nearest observed score at (1-rho) avoids interpolation ambiguity.
    threshold = float(np.quantile(risk, 1 - cfg['rejection_fraction'], method='higher'))
    kept = risk <= threshold
    if not kept.any():
        raise ValueError('no retained calibration samples')
    return refs, threshold, finite_quantile(np.asarray(scores)[kept], cfg['alpha'])


def apply_routing(refs, components, threshold, weights):
    risk = sum(w * percentile(ref, comp) for w, ref, comp in zip(
        weights, refs, components))
    return risk, risk > threshold
