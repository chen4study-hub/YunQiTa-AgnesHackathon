import gzip,json,math
from decimal import Decimal
from datetime import date
import pytest
from src.ops.config import ROOT,SCENARIOS,canonical,FLOOR_HEIGHT_M,MAX_SPEED_M_S
from src.ops.generated import generate
from src.ops.elevators import state_at,motion,dispatch_interval
from src.ops.calendar import document,route
from scripts.export_ops import validate,encode_day

@pytest.fixture(scope='module')
def days():
    revisions={s:json.loads((ROOT/'exports/replay'/(s+'.ops.json')).read_bytes())['meta']['source_git_commit'] for s in SCENARIOS}
    return {s:generate(s,revision=revisions[s]) for s in SCENARIOS}

@pytest.mark.parametrize('scenario',SCENARIOS)
def test_contract_size_and_bytes(days,scenario):
    encoded=encode_day(days[scenario])
    assert encoded==encode_day(generate(scenario,revision=days[scenario]['meta']['source_git_commit']))
    for name,raw in encoded.items():
        validate(raw)
        assert raw==(ROOT/'exports/replay'/name).read_bytes()
        assert len(raw)<=800000
        assert len(gzip.compress(raw,compresslevel=9,mtime=0))<=150000

@pytest.mark.parametrize('scenario',SCENARIOS)
def test_balance_and_history(days,scenario):
    d=days[scenario]
    for row in d['hours']+d['history']['hours']:
        total=Decimal(str(row['actual_kw']))
        assert sum(Decimal(str(f['floor_actual_kw'])) for f in row['floors'])==total
        assert sum(Decimal(str(v)) for v in row['end_uses'].values())==total
        if row['point_kw'] is not None:
            assert sum(Decimal(str(f['floor_kw'])) for f in row['floors'])==Decimal(str(row['point_kw']))
        assert row['environment']['people']==sum(f['occupancy_people'] for f in row['floors'])
        assert 40<=row['environment']['relative_humidity_pct']<=65
        assert len(row['floors'])==40
        assert all(len(f['zones'])==6 for f in row['floors'])
    assert [h['offset_ms'] for h in d['history']['hours']]==list(range(-6*3600000,0,3600000))
    assert d['history']['source_date']<d['meta']['source_date']
    assert all(h['source_t'].startswith(d['history']['source_date']) for h in d['history']['hours'])
    assert d['history']['agent_records']==[]

@pytest.mark.parametrize('scenario',SCENARIOS)
def test_lift_continuity_stops_speed(days,scenario):
    d=days[scenario]
    for lift in d['elevators']:
        stops=set(range(1,21)) if lift['id'].startswith('L') else {1,*range(21,41)}
        floor,end=1,0
        for t in lift['trips']:
            assert t['from_floor']==floor and t['depart_ms']>=end
            assert t['from_floor'] in stops and t['to_floor'] in stops
            assert t['arrive_ms']+t['dwell_ms']<=86400000
            assert 0<=t['load_pct']<=100
            a,_,_=motion(t['from_floor'],t['to_floor'])
            assert a*d['meta']['acceleration_m_s2']<=MAX_SPEED_M_S+1e-9
            local={**lift,'initial_floor':t['from_floor'],'trips':[t]}
            span=t['arrive_ms']-t['depart_ms']
            for step in range(20):
                x=t['depart_ms']+span*step/20;y=t['depart_ms']+span*(step+1)/20
                speed=abs(state_at(local,y)['floor']-state_at(local,x)['floor'])*FLOOR_HEIGHT_M/((y-x)/1000)
                assert speed<=MAX_SPEED_M_S+1e-8
            assert state_at(local,t['arrive_ms'])['floor']==t['to_floor']
            floor,end=t['to_floor'],t['arrive_ms']+t['dwell_ms']
        assert floor==1 and state_at(lift,86400000)['floor']==1


def test_calendar():
    d=document();validate(canonical(d))
    assert len(d['days'])==730
    assert route(date(2026,10,10))=='normal'
    assert route(date(2026,10,1))=='abstain'
    assert route(date(2027,7,1))=='peak'
    assert 'pending' in d['policy']['2027']
    assert canonical(d)==(ROOT/'exports/replay/ops-calendar.json').read_bytes()


def test_words_and_rules(days):
    banned=('典型日','情景','回放','模拟','估算','推算','演示','预测','非设备实测','非实测')
    for d in [*days.values(),document()]:
        assert not any(w in canonical(d).decode('utf-8') for w in banned)
    for d in days.values():
        assert 'notes' not in d['meta']
        for group in ('alerts','work_orders','agent_order_refs'):
            assert all(not __import__('re').search(r'20\d{6}',x['id']) for x in d[group])
        assert all(a['rule_id'] in {r['id'] for r in d['meta']['rules']} for a in d['alerts'])
        assert len({a['id'] for a in d['alerts']})==len(d['alerts'])
        assert {a['work_order_id'] for a in d['alerts']}=={w['id'] for w in d['work_orders']}


def test_humidity():
    from src.ops.metrics import relative_humidity
    expected=round(100*math.exp(17.625*10/(243.04+10)-17.625*20/(243.04+20)),1)
    assert relative_humidity(10,20,False)==expected
    assert relative_humidity(-10,26,True)==40
    assert relative_humidity(26,26,True)==65
    assert relative_humidity(None,26,True) is None


def test_peak_multi_stop_and_load_direction(days):
    for scenario in ('normal','peak'):
        d=days[scenario]
        for lift in d['elevators']:
            morning=[t for t in lift['trips'] if 8*3600000<=t['depart_ms']<9*3600000]
            assert any(t['from_floor']!=1 and t['to_floor']!=1 for t in morning)
            assert sum(t['passengers'] for t in morning if t['to_floor']>t['from_floor'])>sum(t['passengers'] for t in morning if t['to_floor']<t['from_floor'])
            evening=[t for t in lift['trips'] if 18*3600000<=t['depart_ms']<19*3600000]
            assert any(t['from_floor']!=1 and t['to_floor']!=1 for t in evening)
            assert sum(t['passengers'] for t in evening if t['to_floor']<t['from_floor'])>sum(t['passengers'] for t in evening if t['to_floor']>t['from_floor'])
            assert len({t['load_pct'] for t in morning})>=3


@pytest.mark.parametrize('scenario', ('normal','peak'))
@pytest.mark.parametrize('start,end', ((8*3600000, int(9.5*3600000)),
                                     (int(17.5*3600000),19*3600000)))
def test_peak_30_second_motion_occupancy(days,scenario,start,end):
    lifts=days[scenario]['elevators']
    samples=list(range(start,end,30000))
    moving=[[state_at(l,t)['status'] in ('up','down') for t in samples] for l in lifts]
    shares=[sum(row)/len(samples) for row in moving]
    assert all(share>=.5 for share in shares), (scenario, start, shares)
    assert sum(shares)>=3, (scenario, start, shares)


@pytest.mark.parametrize('scenario', ('normal','peak'))
def test_completion_driven_peak_and_door_times(days,scenario):
    for lift in days[scenario]['elevators']:
        trips=lift['trips']
        returns=[(i,t) for i,t in enumerate(trips[:-1]) if t['to_floor']==1
                 and 8*3600000<=t['arrive_ms'] and t['arrive_ms']+t['dwell_ms']<9.5*3600000]
        assert returns
        for i,t in returns:
            next_trip=trips[i+1]
            assert next_trip['from_floor']==1
            assert next_trip['depart_ms']==t['arrive_ms']+t['dwell_ms']
            assert t['dwell_ms']==next_trip['passengers']*1200
        for t in trips:
            assert t['load_pct']==round(t['passengers']/20*100,1)
            if t['to_floor']!=1:
                assert 6000<=t['dwell_ms']<=8000
        # Each car's first busy departure is phase shifted, not synchronized.
    starts=[next(t['depart_ms'] for t in l['trips'] if t['depart_ms']>=7.5*3600000 and t['from_floor']==1)
            for l in days[scenario]['elevators']]
    assert len(set(starts[:3]))==3 and len(set(starts[3:]))==3


@pytest.mark.parametrize('scenario', ('normal','peak'))
@pytest.mark.parametrize('start,end,outbound', ((int(11.5*3600000),int(12.25*3600000),True),
                                             (int(12.75*3600000),int(13.5*3600000),False)))
def test_lunch_loaded_direction_and_activity(days,scenario,start,end,outbound):
    lifts=days[scenario]['elevators']
    upward=downward=0
    for lift in lifts:
        for t in lift['trips']:
            if start<=t['depart_ms']<end:
                if t['to_floor']>t['from_floor']:upward+=t['passengers']
                else:downward+=t['passengers']
    assert (downward>upward if outbound else upward>downward)
    samples=list(range(start,end,30000))
    assert sum(sum(state_at(l,t)['status'] in ('up','down') for t in samples)/len(samples) for l in lifts)>=3


def test_lower_staffing_reduces_departures(days):
    counts={s:sum(8*3600000<=t['depart_ms']<9*3600000 and t['from_floor']==1
                  for l in d['elevators'] for t in l['trips']) for s,d in days.items()}
    assert counts['abstain'] < counts['normal'] * .4
    assert dispatch_interval(0,8) is None
    assert dispatch_interval(500,8) > dispatch_interval(1700,8)



def test_units_preserve_contract_unicode(days):
    for day in days.values():
        units=day['meta']['units']
        assert units['temperature']=='\u00b0C'
        assert units['fresh_air']=='m\u00b3/h'
        assert units['pm25']=='\u03bcg/m\u00b3'
        assert units['solar']=='W/m\u00b2'



@pytest.mark.parametrize('scenario',SCENARIOS)
def test_source_sha_matches_head_export(days,scenario):
    import hashlib,subprocess
    raw=subprocess.check_output(['git','show',f'HEAD:exports/replay/{scenario}.json'],cwd=ROOT)
    expected=hashlib.sha256(raw).hexdigest()
    saved=json.loads((ROOT/'exports/replay'/(scenario+'.ops.json')).read_bytes())
    assert days[scenario]['meta']['source_sha256']==expected
    assert saved['meta']['source_sha256']==expected
    revision=saved['meta']['source_git_commit']
    recorded=subprocess.check_output(['git','show',f'{revision}:exports/replay/{scenario}.json'],cwd=ROOT)
    assert recorded==raw
    latest=subprocess.check_output(['git','log','-1','--format=%H','HEAD','--',f'exports/replay/{scenario}.json'],cwd=ROOT).decode('ascii').strip()
    assert revision==latest


def test_generate_ignores_uncommitted_main_exports(monkeypatch):
    from pathlib import Path
    from src.ops.git_evidence import head_revision
    revision=head_revision()
    before=generate('normal',include_history=False,revision=revision)
    original=Path.read_bytes
    def no_worktree_main(path):
        if path.parent==ROOT/'exports/replay' and path.name in {s+'.json' for s in SCENARIOS}:
            pytest.fail('generation must read committed exports through git show')
        return original(path)
    monkeypatch.setattr(Path,'read_bytes',no_worktree_main)
    assert canonical(before)==canonical(generate('normal',include_history=False,revision=revision))
    assert len(document()['days'])==730



def test_aggregated_alert_budget_and_no_duplicate_episodes(days):
    for scenario in ('normal','peak'):
        d=days[scenario]
        assert len(d['alerts'])<20  # No faults is valid; never manufacture a minimum count.
        for rule in {a['rule_id'] for a in d['alerts']}:
            episodes=sorted((a for a in d['alerts'] if a['rule_id']==rule),key=lambda a:a['offset_ms'])
            for prior,later in zip(episodes,episodes[1:]):
                assert prior['resolved_offset_ms'] is not None
                assert prior['resolved_offset_ms']<later['offset_ms']



@pytest.mark.parametrize('scenario', ('normal','peak'))
@pytest.mark.parametrize('start,end', ((10*3600000,16*3600000),(14*3600000,16*3600000)))
def test_daytime_30_second_flow_has_group_coverage(days,scenario,start,end):
    lifts=days[scenario]['elevators']
    samples=list(range(start,end,30000))
    group_counts=[]
    for zone in ('low','high'):
        group=[l for l in lifts if l['zone']==zone]
        counts=[sum(state_at(l,t)['status'] in ('up','down') for l in group) for t in samples]
        assert min(counts)>=1, (scenario,zone,[t for t,c in zip(samples,counts) if c==0])
        group_counts.append(counts)
        # Not just empty repositioning: a loaded, non-lobby meeting leg exists.
        assert any(start<=t['depart_ms']<end and t['from_floor']!=1 and t['to_floor']!=1 and t['passengers']>0
                   for l in group for t in l['trips'])
    assert sum(sum(c) for c in group_counts)/len(samples)>=2



def test_daytime_gate_uses_building_not_per_zone_staffing(days):
    import copy
    from src.ops.elevators import fleet
    hours=copy.deepcopy(days['normal']['hours'])
    for row in hours:
        for floor in row['floors']:
            floor['occupancy_people']=30
    lifts=fleet(days['normal']['meta']['source_date'],hours)
    samples=list(range(10*3600000,16*3600000,30000))
    for zone in ('low','high'):
        group=[l for l in lifts if l['zone']==zone]
        assert all(any(state_at(l,t)['status'] in ('up','down') for l in group) for t in samples)
