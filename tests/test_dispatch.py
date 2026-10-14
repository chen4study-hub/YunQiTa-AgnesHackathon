import json
from src.agent.dispatch import dispatch,score_confidence


def test_dispatch_is_log_only(tmp_path):
    path=tmp_path/'dispatch.jsonl'
    record=dispatch({'status':'executed','actions':['hold']},path)
    assert record['device_connected'] is False and record['transport']=='log_only'
    assert json.loads(path.read_text(encoding='utf-8'))==record
    assert score_confidence(.2)==.8
