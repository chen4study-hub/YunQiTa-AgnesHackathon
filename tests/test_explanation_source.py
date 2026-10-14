from src.data.replay_payload import load_replay
import copy,json,subprocess
from pathlib import Path
import pytest
from jsonschema import Draft202012Validator
from src.agent.orchestrator import run_agent
from tests.test_agent_orchestrator import fixtures


@pytest.mark.parametrize('text,expected',[('选择保持设定。','llm'),('choose hold','template'),('prepare 99999','template')])
def test_live_explanation_provenance(text,expected):
    f,c=fixtures()
    class Provider:
        def choose_candidate(self,*args):
            return {'choice':{'candidate_id':'rule_hold','reason':text},'llm':{'mode':'real','reason':'call_succeeded'}}
    out=run_agent(f,c,provider=Provider(),dispatch_enabled=False)
    assert out['explanation_source']==expected
    assert out['source']=='llm'
    assert '99999' not in out['reason']


def test_contract_only_optional_field_and_all72_exports():
    schema=json.loads(Path('contracts/replay.schema.json').read_text(encoding='utf-8'))
    previous=json.loads(subprocess.check_output(['git','show','a6e8df7:contracts/replay.schema.json']).decode())
    # Freeze the schema at the explanation_source introduction, before later
    # manual-reference and temperature-optimization schema additions.
    stripped=json.loads(subprocess.check_output(['git','show','5d77281:contracts/replay-1.4.schema.json']).decode())
    assert stripped['$defs'].pop('weather')['properties']['relative_humidity_pct']['maximum']==100
    for name in ['hour','forecast']:assert stripped['$defs'][name]['properties'].pop('weather')=={'$ref':'#/$defs/weather'}
    stripped['$id']=previous['$id'];stripped['title']=previous['title'];stripped['properties']['schema_version']=previous['properties']['schema_version']
    props=stripped['$defs']['hour']['properties']['agent']['properties']
    assert props.pop('explanation_source')['enum']==['llm','template']
    # Current display-only label replaces a banned word; no structural field change.
    stripped['properties']['energy_summary']['properties']['label']=previous['properties']['energy_summary']['properties']['label']
    assert stripped==previous
    validator=Draft202012Validator(schema)
    receipt=json.loads(Path('experiments/agent_replay_export.json').read_text())
    for scenario in ['normal','peak','abstain']:
        compact=load_replay(scenario,hydrate=False);validator.validate(compact)
        data=load_replay(scenario)
        counts={'llm':0,'template':0,'rule':0}
        for r in data['hours']:
            a=r['agent'];assert a['explanation_source'] in ('llm','template')
            expected='llm' if a['source']=='llm' and a['llm'].get('explanation_mode')=='llm_with_template_upper' else 'template'
            assert a['explanation_source']==expected
            counts['rule' if a['source']=='rule' else a['explanation_source']]+=1
        assert counts=={k:receipt['explanation_categories_by_scenario'][scenario].get(k,0) for k in counts}
        # Optional provenance is a legacy-v1.4 guarantee, not an arbitrary
        # downgrade of the daily-calibrated v1.5 deployment payload.
        optional=json.loads(subprocess.check_output(['git','show',f'5d77281^:exports/replay/{scenario}.json']).decode())
        assert optional['schema_version']=='1.4'
        for r in optional['hours']:r['agent'].pop('explanation_source')
        Draft202012Validator(json.loads(Path('contracts/replay-1.4.schema.json').read_text(encoding='utf-8'))).validate(optional)
        invalid=copy.deepcopy(data);invalid['hours'][0]['agent']['explanation_source']='rule'
        assert list(validator.iter_errors(invalid))
