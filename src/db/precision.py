"""Non-mutating display precision at response boundaries, never for control validation."""
from decimal import Decimal, ROUND_HALF_EVEN
import math


FOUR_DECIMAL_FIELDS = frozenset({
    'soc', 'storage_soc', 'initial_soc', 'min_soc', 'max_soc',
    'reference_soc_before', 'reference_soc_after', 'soc_before', 'soc_after',
    'ratio', 'share', 'fraction', 'proportion',
})
ONE_DECIMAL_FIELDS = frozenset({'power', 'energy', 'temperature'})


def display_precision(value, field=''):
    """Copy JSON-like values; preserve IDs, times, counters, booleans and text."""
    if isinstance(value, dict):
        return {key: display_precision(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [display_precision(item, field) for item in value]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return value
    name = field.lower()
    if name in FOUR_DECIMAL_FIELDS or name.endswith(('_soc', '_ratio', '_share', '_fraction', '_proportion')):
        places = 4
    elif name in ONE_DECIMAL_FIELDS or name.endswith(('_kw', '_kwh', '_c')):
        places = 1
    else:
        return value
    rounded = float(Decimal(str(value)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_EVEN))
    return 0.0 if rounded == 0 else rounded
