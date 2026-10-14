"""Validate refreshed planner exports in an OS temporary directory only."""
import copy
import gzip
import hashlib
import json
import tempfile
from datetime import datetime
from pathlib import Path
from jsonschema import Draft202012Validator
from src.agent.orchestrator import run_agent
from src.agent.manual_reference import align_export_segments
from src.agent.rolling_context import from_replay
from src.agent.tools import check_constraints
from src.data.replay_payload import load_replay, split_payload, hydrate_hour


class OfflineChoice:
    def choose_candidate(self, forecast, candidates, instruction):
        return {'choice':{}, 'llm':{'mode':'rule', 'reason':'key_unavailable'}}


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def validate_exports(root):
    root = Path(root); comparisons = []; count = 0; size_changes={}; precool_hours=0; reference_examples={};temperature_ticks=set();explained_holds=0
    schemas = [json.loads(Path(p).read_text(encoding='utf-8')) for p in
               ('contracts/replay.schema.json', 'contracts/agent-detail.schema.json')]
    for name in ('normal', 'peak', 'abstain'):
        data = load_replay(name); soc = .5
        existing_bytes=(Path('exports/replay')/f'{name}.json').read_bytes()
        for row in data['hours']:
            forecast, context, limits = from_replay(data, row, soc)
            result = run_agent(forecast, context, limits, provider=OfflineChoice(), dispatch_enabled=False,
                               dispatch_current_only=True)
            selected=next(c for c in result['candidates'] if c['candidate_id']==result['selected'])
            guard=selected['temperature_optimization']
            assert guard['selection_guard_passed']
            assert all(value is None or guard['after'][key]<=value+1e-7
                       for key,value in guard['selection_guard_caps'].items())
            command = result['plan'][0]; soc -= command['battery_kw']/limits['battery_capacity_kwh']
            assert not check_constraints(result['plan'], limits)
            refused = forecast['predictions'][0]['abstain']
            row['storage'] = dict(power_kw=command['battery_kw'], soc=soc)
            row['agent'] = dict(status='handoff' if refused else 'executed', source='rule',
                explanation_source='template', selected=result['selected'],
                hvac_setpoint_c=command['hvac_setpoint_c'], explanation=result['reason'],
                actions=[] if refused else [f"设定温度 {command['hvac_setpoint_c']:.1f} °C",
                                            f"储能功率 {command['battery_kw']:.1f} kW"],
                receipt=result['receipt'], candidates=result['candidates'],
                selection_reason=result['selection_reason'], work_orders=result['work_orders'],
                manual_reference=result['manual_reference'], llm=result['llm'])
            row['grid_kw']=round(max(0., row['actual_kw']-command['battery_kw']-row['pv']['power_kw']),1)
            count += len(result['manual_reference'])
            for candidate in result['candidates']:
                assert all(p['hvac_setpoint_c']==round(p['hvac_setpoint_c'],1) for p in candidate['plan'])
                precool_hours+=sum(p['action']=='precool' for p in candidate['plan'])
                temperature_ticks.update(p['hvac_setpoint_c'] for p in candidate['plan'] if p['action']!='human_review')
                assert all(24.5<=p['hvac_setpoint_c']<=25. for p in candidate['plan'] if p['action']=='precool')
            for ref in result['manual_reference']:
                if ref['hvac_setpoint_c']==25.5 and round(ref['battery_kw'],1)==0.:
                    assert '电量' in ref['reason'] and '%' in ref['reason'] and ('kWh' in ref['reason'] or '下限' in ref['reason'])
                    explained_holds+=1
            assert all(len(p['reason'])<=60 and p['hvac_setpoint_c']==round(p['hvac_setpoint_c'],1) for p in result['manual_reference'])
            for c in result['candidates']:
                comparison = c['temperature_optimization']
                assert all(value is None or comparison['after'][key]<=value+1e-7
                           for key, value in comparison['before'].items())
                comparisons.append(dict(date=row['t'], dataset=name, candidate_id=c['candidate_id'],
                                        **comparison))
        align_export_segments(data)
        main, detail = split_payload(data)
        whole_window=copy.deepcopy(main)
        for i,row in enumerate(main['hours']):
            refs=row['agent'].get('manual_reference',[])
            assert len(refs)<=1 and all(r['timestamp']==row['t'] for r in refs)
            whole_window['hours'][i]['agent']['manual_reference']=copy.deepcopy(
                detail['hours'][str(i)]['agent'].get('manual_reference',[]))
            if refs and ((name=='peak' and datetime.fromisoformat(row['t']).hour==8) or
                         (name=='abstain' and 8<=datetime.fromisoformat(row['t']).hour<=19)):
                reference_examples.setdefault(name,[]).extend(refs)
        whole_raw=encode(whole_window)
        def sizes(raw):return dict(raw_bytes=len(raw),gzip_bytes=len(gzip.compress(raw,mtime=0)))
        size_changes[name]=dict(existing_main=sizes(existing_bytes),whole_window_main=sizes(whole_raw),
                                current_only_main=sizes(encode(main)))
        if name=='abstain':
            for row in main['hours'][8:20]:
                ref=row['agent']['manual_reference'][0]
                assert ref['suggested_duration_hours']==12 and ref['remaining_duration_hours']==20-datetime.fromisoformat(row['t']).hour
        raw = encode(main); detail['main_sha256'] = hashlib.sha256(raw).hexdigest()
        for schema, value in zip(schemas, (main, detail)):
            Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER).validate(value)
        assert [hydrate_hour(main, r, detail) for r in main['hours']]==data['hours']
        (root/f'{name}.json').write_bytes(raw)
        (root/f'{name}.agent-detail.json').write_bytes(encode(detail))
    (root/'comparison.json').write_bytes(encode(comparisons))
    examples = [c for c in comparisons if c['dataset']=='normal' and
                datetime.fromisoformat(c['date']).hour==14]
    return dict(directory=str(root), windows=72, comparisons=len(comparisons), examples=examples,
                improved=sum(c['applied'] for c in comparisons), manual_reference_hours=count,
                schema_valid=True, exact_roundtrip=True, selected_regressions=0, dispatches=0, precool_hours=precool_hours,
                main_sizes=size_changes, reference_examples=reference_examples,
                temperature_ticks=sorted(temperature_ticks), explained_holds=explained_holds)


def main():
    with tempfile.TemporaryDirectory(prefix='agnes-planner-') as directory:
        print(json.dumps(validate_exports(directory), ensure_ascii=False))


if __name__=='__main__':
    main()
