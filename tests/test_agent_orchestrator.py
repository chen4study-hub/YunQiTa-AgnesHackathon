import json
import pytest
from src.agent.orchestrator import run_agent,check_grounding,schedule_candidate
from src.agent.tools import tool_config
from src.agent.dispatch import dispatch_to_bms


def fixtures():
    times=['2017-07-20T06:00:00-05:00','2017-07-20T07:00:00-05:00','2017-07-20T08:00:00-05:00']
    f={'building_id':'A','predictions':[dict(timestamp=t,point=1000.,lower=900.,upper=1200.,confidence=.95,abstain=False,abstain_reason=None) for t in times]}
    c={'hours':[dict(timestamp=t,tariff_period=period,pv_kw=0.,outdoor_temp_c=30.,price_per_kwh=.75) for t,period in zip(times,['valley','flat','peak'])]}
    return f,c


def test_demo_full_pipeline_and_split_ba_ems(monkeypatch,tmp_path):
    monkeypatch.setenv('LLM_MODE','demo')
    from src.agent import provider
    monkeypatch.setattr(provider.httpx,'Client',lambda **k:pytest.fail('demo must be offline'))
    f,c=fixtures();path=tmp_path/'dispatch.jsonl'
    r=run_agent(f,c,dispatch_path=path)
    assert r['source']=='demo' and len(r['candidates'])==3
    full=r['candidates'][0]['plan']
    assert full[0]['battery_kw']<0 and full[-1]['battery_kw']>0
    assert 24<=full[0]['hvac_setpoint_c']<=27
    assert full[-1]['hvac_setpoint_c']==25.5
    from src.agent.zone_comfort import maximum_zone_temperature,occupied
    for cmd,pred,hour in zip(full,f['predictions'],c['hours']):
        if occupied(pred):assert maximum_zone_temperature(pred,hour,cmd['hvac_setpoint_c'])<=27.0
    for candidate in r['candidates']:
        comparison=candidate['temperature_optimization']
        assert all(comparison['after'][key]<=value+1e-7 for key,value in comparison['before'].items())
    assert r['selected']=='rule_hold' and r['selection_reason']['objective_optimal']
    assert '1,200' in r['reason'] and r['receipt']['count']==6
    entries=[json.loads(s) for s in path.read_text().splitlines()]
    assert {e['destination'] for e in entries}=={'BA','EMS'}
    assert all(not e['device_connected'] for e in entries)


def test_refusal_work_order_never_dispatches_refused_hour(tmp_path):
    f,c=fixtures();f['predictions'][1]['abstain']=True
    class Provider:
        calls=0
        def choose_candidate(self,f,c,instruction):
            self.calls+=1
            preferred=next(x for x in c if x['selection_reason']['objective_optimal'])
            return {'choice':{'candidate_id':preferred['candidate_id'],'reason':'按区间上界1200千瓦准备。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    provider=Provider()
    path=tmp_path/'dispatch.jsonl';r=run_agent(f,c,provider=provider,dispatch_path=path)
    assert provider.calls==1 and len(r['work_orders'])==1 and r['source']=='llm'
    assert r['work_orders'][0]['conservative_default']['battery_kw']==0
    assert r['receipt']['count']==4
    assert f['predictions'][1]['timestamp'] not in path.read_text()
    for row in f['predictions']:row['abstain']=True
    r=run_agent(f,c,provider=provider,dispatch_path=tmp_path/'absent.jsonl')
    assert provider.calls==1 and r['llm']['reason']=='refused_current'
    assert r['receipt']['count']==0 and not (tmp_path/'absent.jsonl').exists()


def test_invalid_output_and_hallucinated_numbers_retry_once_then_rule(tmp_path):
    f,c=fixtures()
    class Bad:
        count=0
        def choose_candidate(self,*args):
            self.count+=1
            return {'choice':{'candidate_id':'rule_full','reason':'按1200 kW上界准备，收益999999 kW'},'llm':{'mode':'real'}}
    p=Bad();r=run_agent(f,c,provider=p,dispatch_path=tmp_path/'d.jsonl')
    assert p.count==2 and r['source']=='rule' and '999999' not in r['reason']
    assert check_grounding('上界1200 kW',{'upper':1200})
    assert not check_grounding('收益999 kW',{'upper':1200})


def test_format_failure_then_valid_choice(tmp_path):
    f,c=fixtures()
    class Retry:
        count=0
        def choose_candidate(self,*args):
            self.count+=1
            choice={} if self.count==1 else {'candidate_id':'rule_hold','reason':'按区间上界1200 kW准备'}
            return {'choice':choice,'llm':{'mode':'real'}}
    p=Retry();r=run_agent(f,c,provider=p,dispatch_path=tmp_path/'d.jsonl')
    assert p.count==2 and r['source']=='llm' and r['selected']=='rule_hold'


def test_dispatch_sink_rejects_handoff(tmp_path):
    with pytest.raises(ValueError):dispatch_to_bms([{'action':'human_review'}],'A',tmp_path/'d.jsonl')
    assert not (tmp_path/'d.jsonl').exists()


def test_real_transport_failure_is_rule_not_mock_source(tmp_path):
    f,c=fixtures()
    class Failed:
        def choose_candidate(self,*args):
            return {'choice':{'candidate_id':'rule_full','reason':'按区间上界1200.0 kW准备'},
                    'llm':{'mode':'mock','reason':'call_failed','error_type':'ReadTimeout','status_code':None}}
    result=run_agent(f,c,provider=Failed(),dispatch_path=tmp_path/'d.jsonl')
    assert result['source']=='rule'
    assert result['llm']['error_type']=='ReadTimeout'


def test_free_choice_receives_rounded_tools_and_keeps_real_controls(tmp_path):
    f,c=fixtures();f['predictions'][0]['upper']=1230.837878190377
    class Free:
        def choose_candidate(self,forecast,candidates,instruction):
            assert forecast['predictions'][0]['upper']==1230.8
            assert 'must be exactly' not in instruction
            return {'choice':{'candidate_id':'rule_hold','reason':'选择保持设定方案，按上界1230.8 kW准备。'},'llm':{'mode':'real'}}
    r=run_agent(f,c,provider=Free(),dispatch_path=tmp_path/'d.jsonl')
    assert r['source']=='llm' and r['plan'][0]['prepared_upper_kw']==1230.837878190377


def test_retry_identifies_unsourced_number_and_uses_chinese_tool_actions(tmp_path):
    f,c=fixtures()
    class Retry:
        count=0
        def choose_candidate(self,forecast,candidates,instruction):
            self.count+=1
            assert candidates[0]['plan'][0]['action'] in ('提前预冷','储能调度','保持设定')
            if self.count==1:reason='按上界1200 kW准备，收益999.9元。'
            else:
                assert 'Numbers without a numeric tool source: 999.9' in instruction
                reason='按上界1200 kW准备，采用提前预冷和储能调度。'
            return {'choice':{'candidate_id':'rule_hold','reason':reason},'llm':{'mode':'real'}}
    p=Retry();r=run_agent(f,c,provider=p,dispatch_path=tmp_path/'d.jsonl')
    assert p.count==1 and r['source']=='llm' and r['explanation_source']=='template'
    assert '999.9' not in r['reason'] and r['llm']['prose_repair']['dropped_sentences']==1


def test_english_action_reason_is_rejected_without_relaxing_grounding(tmp_path):
    f,c=fixtures()
    class English:
        def choose_candidate(self,*args):
            return {'choice':{'candidate_id':'rule_hold','reason':'按上界1200 kW准备，hold。'},'llm':{'mode':'real','reason':'call_succeeded'}}
    r=run_agent(f,c,provider=English(),dispatch_path=tmp_path/'d.jsonl')
    assert r['source']=='llm' and r['llm']['explanation_mode']=='llm_with_template_upper'
    assert 'hold' not in r['reason']
