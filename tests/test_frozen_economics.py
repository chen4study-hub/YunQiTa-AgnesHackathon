"""Accounting for frozen v1/v2/v4 evaluations before the zone-comfort update.

Cost/peak accounting still uses the current implementation (unchanged formula).
The historical comfort field is independently recomputed with the pre-58c7142
indoor formula; it must not be confused with the current per-zone authority.
"""
from scripts.evaluate_agent13 import current_economics
from src.agent.tools import tool_config


def historical_economics(command, forecast, context, limits):
    result = current_economics(command, forecast, context, limits)
    if forecast['predictions'][0]['abstain']:
        return result
    model = tool_config()['linear_model']
    indoor = command['hvac_setpoint_c'] + model['outdoor_gain'] * max(
        0., context['hours'][0]['outdoor_temp_c'] - model['outdoor_reference_c'])
    result['comfort_degree_hours'] = (max(0., limits['min_temp_c'] - indoor)
                                     + max(0., indoor - limits['max_temp_c']))
    return result


def test_historical_comfort_formula_matches_frozen_source():
    import subprocess
    source = subprocess.check_output(
        ['git', 'show', '58c7142^:src/agent/tools.py']).decode('utf-8')
    assert "indoor=temp+model['outdoor_gain']*max(0.,float(outdoor)-model['outdoor_reference_c'])" in source
