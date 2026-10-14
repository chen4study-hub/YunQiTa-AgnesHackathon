"""Replay 1.5 display payload and lazy, hash-bound frozen evidence hydration.

No provider/model calls. Origin persistence fields are reconstructed only from
current/past evidence already present in the export, never future measurements.
"""
import copy,hashlib,json,math
from pathlib import Path
from decimal import Decimal,ROUND_HALF_EVEN

ROOT=Path(__file__).resolve().parents[2]
SCENARIOS=('normal','peak','abstain')
DERIVED_FORECAST=('hvac','hvac_electric_estimate_kw','hvac_electric_estimated_share',
    'floors_hvac_electric_estimate_kw','floors_non_hvac_estimate_kw','weather')
AGENT_DISPLAY=('status','source','explanation_source','selected','hvac_setpoint_c',
    'explanation','actions','receipt')
PROBABILITY=('confidence','confidence_threshold','risk_score','risk_threshold','soc','storage_soc','reference_soc_before','reference_soc_after')


def display_precision(obj,key='',metadata=False):
    """Nearest display precision, no change to IDs/counts/model constants.

    Frozen runtime evidence is NOT a display surface and is kept separately.
    """
    if isinstance(obj,dict):
        return {k:display_precision(v,k,metadata or k in ('meta','policy')) for k,v in obj.items()}
    if isinstance(obj,list):return [display_precision(v,key,metadata) for v in obj]
    if isinstance(obj,bool) or not isinstance(obj,(int,float)):return obj
    if not math.isfinite(obj):raise ValueError('nonfinite export value')
    if metadata and key not in PROBABILITY:return obj
    precision=4 if key in PROBABILITY or 'share' in key or 'fraction' in key or key.endswith('_ratio') else 1 if (
        key.endswith(('_kw','_kwh','_cny','_c')) or key in ('estimated_cost','estimated_savings','cost','before_cost','after_cost','baseline_cost','elapsed_ms','comfort_degree_hours','x','y','z','lat','lon','latitude','longitude','relative_humidity_pct')) else None
    if precision is None:return obj
    value=float(Decimal(str(obj)).quantize(Decimal(1).scaleb(-precision),rounding=ROUND_HALF_EVEN))
    return 0. if value==0 else value


def runtime_evidence(row):
    """Retain exact numeric leaves only where display rounding loses precision."""
    def leaves(obj,path=()):
        if isinstance(obj,dict):
            for k,v in obj.items():yield from leaves(v,path+(k,))
        elif isinstance(obj,list):
            for i,v in enumerate(obj):yield from leaves(v,path+(i,))
        elif isinstance(obj,(int,float)) and not isinstance(obj,bool):yield path,obj
    display=display_precision(row);out=[]
    for path,value in leaves(row):
        current=display
        for part in path:current=current[part]
        # Agent has its own full evidence object; removed derived fields can be
        # reconstructed before applying these numeric overrides.
        if path[0]=='agent':continue
        if current!=value:out.append({'path':list(path),'value':value})
    return {'numeric_overrides':out}


def candidate_summary(candidate,t):
    command=next(p for p in candidate['plan'] if p['timestamp']==t)
    metrics=candidate['objective_metrics'];simulation=candidate['simulation']
    return dict(candidate_id=candidate['candidate_id'],hvac_setpoint_c=command['hvac_setpoint_c'],
        battery_kw=command['battery_kw'],energy_cost_cny=simulation.get('estimated_cost'),
        point_grid_peak_kw=simulation.get('estimated_peak_kw'),upper_grid_peak_kw=metrics.get('upper_grid_peak_kw'),
        constraint_valid=metrics.get('constraint_violations')==0,accepted_hours=metrics['accepted_hours'],
        excluded_hours=metrics['excluded_refused_hours'],
        **({'temperature_optimization':copy.deepcopy(candidate['temperature_optimization'])}
           if 'temperature_optimization' in candidate else {}))


def split_payload(data):
    """Input is a fully hydrated 1.4/1.5 document; output main plus detail."""
    full=copy.deepcopy(data);main=display_precision(full);scenario=full['meta']['scenario']
    detail={'schema_version':'1.5','scenario':scenario,'building_id':full['meta']['building_id'],'main_sha256':'',
        'origin_metadata':copy.deepcopy(full['meta']),'hours':{}}
    detail['origin_metadata'].pop('agent_detail_file',None)
    main['schema_version']='1.5';main['meta']['agent_detail_file']=scenario+'.agent-detail.json'
    for i,(original,row) in enumerate(zip(full['hours'],main['hours'])):
        agent=original['agent']
        detail['hours'][str(i)]={'t':original['t'],'agent':copy.deepcopy(agent),'runtime_evidence':runtime_evidence(original)}
        summary={k:copy.deepcopy(agent[k]) for k in AGENT_DISPLAY}
        if 'manual_reference' in agent:
            summary['manual_reference']=[copy.deepcopy(r) for r in agent['manual_reference'] if r['timestamp']==original['t']]
        summary['detail_index']=i
        summary['planning_horizon_hours']=len(agent['candidates'][0]['plan'])
        summary['candidate_summaries']=[candidate_summary(c,original['t']) for c in agent['candidates']]
        if agent.get('work_orders'):summary['ticket_summary']=copy.deepcopy(agent['work_orders'][0])
        row['agent']=display_precision(summary)
        for p in row['forecast_24h']:
            for field in DERIVED_FORECAST:p.pop(field,None)
    return main,detail


def restore_derived(row,method):
    """Pure exported-method reconstruction; no raw meters/scripts/experiments needed."""
    from datetime import datetime
    for p in row['forecast_24h']:
        if 'hvac' not in p:
            readings=copy.deepcopy(row['hvac']['effective_readings']);month=datetime.fromisoformat(p['t']).month
            mode='cooling' if month in method['cooling_months'] else 'heating' if month in method['heating_months'] else 'shoulder'
            needed=['chilledwater'] if mode=='cooling' else ['steam'] if mode=='heating' else ['chilledwater','steam']
            available=all(readings[k]['effective_kwh'] is not None for k in needed);total=p['point_kw']
            if available:
                thermal=sum(readings[k]['effective_kwh'] for k in needed)
                electric=sum(readings[k]['effective_kwh']*method['cooling_auxiliary_electric_fraction' if k=='chilledwater' else 'steam_auxiliary_electric_fraction'] for k in needed)
                capped=min(round(electric,1),math.floor(total*10+1e-7)/10)
            else:thermal=electric=capped=None
            p['hvac']=dict(season=mode,thermal_kw=round(thermal,1) if thermal is not None else None,
                uncapped_electric_estimate_kw=round(electric,1) if electric is not None else None,
                cap_applied=bool(available and electric>total),effective_readings=readings,
                quality='missing' if not available else 'past_fill' if any(readings[k]['age_hours']>0 for k in needed) else 'observed',
                basis='persistence_at_origin',origin=row['t'])
            p['hvac_electric_estimate_kw']=capped
            p['hvac_electric_estimated_share']=round(capped/total,6) if capped is not None and total>0 else None
            if capped is None:a=b=None
            else:
                units=[round(x*10) for x in p['floors_kw']];amount=round(capped*10);total_units=sum(units)
                weights=[x/total_units*amount if total_units else 0. for x in units];base=[math.floor(x) for x in weights]
                order=sorted((i for i,x in enumerate(base) if x<units[i]),key=lambda i:-(weights[i]-base[i]))
                for i in order[:amount-sum(base)]:base[i]+=1
                a=[x/10 for x in base];b=[(x-y)/10 for x,y in zip(units,base)]
            p['floors_hvac_electric_estimate_kw']=a;p['floors_non_hvac_estimate_kw']=b
        if 'weather' not in p and 'weather' in row:
            p['weather']={**copy.deepcopy(row['weather']),'basis':'origin_persistence; not target-time measured or weather forecast'}


def hydrate_hour(data,row,detail):
    scenario=data['meta']['scenario'];index=row['agent'].get('detail_index')
    if detail['schema_version']!='1.5' or detail['scenario']!=scenario or detail['building_id']!=data['meta']['building_id']:
        raise ValueError('agent detail identity mismatch')
    if not isinstance(index,int) or not 0<=index<24:raise ValueError('invalid agent detail index')
    entry=detail['hours'][str(index)]
    if entry['t']!=row['t']:raise ValueError('agent detail origin mismatch')
    out=copy.deepcopy(row);out['agent']=copy.deepcopy(entry['agent'])
    method=detail.get('origin_metadata',data['meta'])['hvac_method'];restore_derived(out,method)
    for override in entry['runtime_evidence']['numeric_overrides']:
        path=override['path'];current=out
        for part in path[:-1]:current=current[part]
        current[path[-1]]=override['value']
    # Reconstruct from exact restored origin context, not its display rounding.
    for p in out['forecast_24h']:
        for field in DERIVED_FORECAST:p.pop(field,None)
    restore_derived(out,method)
    # Derived fields can themselves have exact numeric evidence overrides.
    for override in entry['runtime_evidence']['numeric_overrides']:
        path=override['path'];current=out
        for part in path[:-1]:current=current[part]
        current[path[-1]]=override['value']
    return out


def load_detail(data,root=None):
    scenario=data['meta']['scenario']
    if scenario not in SCENARIOS:raise ValueError('unknown replay scenario')
    expected=scenario+'.agent-detail.json'
    if data['meta'].get('agent_detail_file')!=expected:raise ValueError('invalid agent detail filename')
    root=Path(root) if root is not None else ROOT/'exports/replay'
    raw=(root/f'{scenario}.json').read_bytes();detail=json.loads((root/expected).read_text(encoding='utf-8'))
    if hashlib.sha256(raw).hexdigest()!=detail['main_sha256']:raise ValueError('agent detail/main hash mismatch')
    return detail


def ensure_hour(data,row,root=None):
    if data.get('schema_version')!='1.5' or 'detail_index' not in row.get('agent',{}):return row
    return hydrate_hour(data,row,load_detail(data,root))


def load_replay(scenario,root=None,hydrate=True):
    if scenario not in SCENARIOS:raise ValueError('unknown replay scenario')
    root=Path(root) if root is not None else ROOT/'exports/replay'
    data=json.loads((root/f'{scenario}.json').read_text(encoding='utf-8'))
    if hydrate and data['schema_version']=='1.5':
        detail=load_detail(data,root);data['hours']=[hydrate_hour(data,row,detail) for row in data['hours']]
        data['meta']={**detail.get('origin_metadata',data['meta']),'agent_detail_file':data['meta']['agent_detail_file']}
    return data
