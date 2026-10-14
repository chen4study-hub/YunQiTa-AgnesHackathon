from src.data.replay_payload import load_replay
import json
from pathlib import Path
import re
from pandas.tseries.holiday import USFederalHolidayCalendar
from src.agent.orchestrator import rounded_tools,check_grounding


def test_abstain_day_is_real_observed_holiday_with_mixed_dispatch():
    d=load_replay('abstain')
    holidays=USFederalHolidayCalendar().holidays('2017-01-01','2017-12-31').strftime('%Y-%m-%d')
    assert d['meta']['date'] in holidays and d['meta']['date']!='2017-04-09'
    assert 0<sum(h['abstain'] for h in d['hours'])<24
    assert d['hours'][10]['abstain']


def test_tool_rounding_and_grounding_of_freely_written_reason():
    tools=rounded_tools({'upper':1230.837878190377,'power':54.333,'simulation':{'cost':12.567}})
    assert tools['upper']==1230.8 and tools['simulation']['cost']==12.6
    assert check_grounding('按上界1230.8 kW准备，放电54.3 kW削峰。',tools)
    assert not check_grounding('可以节省999.9元。',tools)
