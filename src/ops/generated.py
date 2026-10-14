"""Deterministic operations derived from frozen source-day evidence."""
import copy
import json
from datetime import date,timedelta
from .config import (ROOT, SCENARIOS, HOUR_MS, canonical, digest, tariff, decimal1,
                     settings, FLOOR_HEIGHT_M, MAX_SPEED_M_S, ACCELERATION_M_S2, ZONES)
from .metrics import floor_rows,environment,end_uses
from .elevators import fleet
from .rules import events,RULES
from .history import prior_sources
from .git_evidence import head_revision,committed_export,export_revision


def make_row(source_date,h,source,uses):
    floors,sun,setpoint = floor_rows(source_date,h,source,uses)
    return {'offset_ms':h*HOUR_MS,'source_t':source['t'],
            'actual_kw':source['actual_kw'],'point_kw':source['point_kw'],
            'outdoor_temp_c':source.get('outdoor_temp_c'),'hvac_setpoint_c':setpoint,
            'solar_w_m2':sun,'floors':floors,
            'environment':environment(source_date,h,source,floors),
            'storage':copy.deepcopy(source['storage']),'pv':copy.deepcopy(source['pv']),
            'grid_kw':source['grid_kw'],'end_uses':{},'energy':{},
            'quality':{'provider':'generated','floor_kw_basis':'point_kw',
                       'floor_actual_kw_basis':'actual_kw','weather':'source_hour',
                       'staffing':'source_date_function'}}


def attach_energy(rows,sources,lifts,prices):
    totals={key:0 for key in ('actual_kwh','hvac_electric_estimate_kwh','lighting_kwh','plug_kwh','elevator_kwh','other_kwh')}
    for row,source in zip(rows,sources):
        h=row['offset_ms']//HOUR_MS
        uses=end_uses(source,h,row['floors'],lifts)
        row['end_uses']=uses
        hourly={'actual_kwh':source['actual_kw'],**{k.replace('_kw','_kwh'):v for k,v in uses.items()}}
        row['energy']={'hour_kwh':hourly,'cumulative_start_kwh':copy.deepcopy(totals),
                       'hour_cost_cny':decimal1(source['actual_kw']*prices[h])}
        for key,value in hourly.items(): totals[key]=decimal1(totals[key]+value)
        row['energy']['cumulative_end_kwh']=copy.deepcopy(totals)
    return totals


def generate(scenario,include_history=True,revision=None):
    if scenario not in SCENARIOS: raise ValueError('unknown scenario')
    revision=revision or head_revision()
    raw=committed_export(scenario,revision); data=json.loads(raw)
    source_date=data['meta']['date']; uses=data['meta']['floor_uses']; prices=tariff()
    rows=[make_row(source_date,h,s,uses) for h,s in enumerate(data['hours'])]
    lifts=fleet(source_date,rows)
    totals=attach_energy(rows,data['hours'],lifts,prices['prices'])
    alerts,orders=events(source_date,rows)
    history={'hours':[],'agent_records':[],'agent_records_quality':'unavailable',
             'source_date':(date.fromisoformat(source_date)-timedelta(days=1)).isoformat(),
             'source_sha256':{}}
    if include_history:
        sources,hashes=prior_sources(data)
        previous=history['source_date']
        old=[make_row(previous,h,s,uses) for h,s in zip(range(18,24),sources)]
        attach_energy(old,sources,[],prices['prices'])
        for row in old:
            row['offset_ms']-=24*HOUR_MS
            row['quality']['floor_kw_basis']='prior_meter_allocation'
            row['quality']['energy']='last_six_hours_only'
        history['hours']=old;history['source_sha256']=hashes
    refs=[]
    for h,s in enumerate(data['hours']):
        ticket=s['agent'].get('ticket_summary')
        if ticket:
            refs.append({'id':f"YQ-{h:02d}-01",
                         'offset_ms':h*HOUR_MS,'source_t':s['t'],
                         'detail_index':s['agent'].get('detail_index',h),
                         'suggested_checks':ticket.get('suggested_checks',[])})
    meta={'scenario':scenario,'source_date':source_date,'building_id':data['meta']['building_id'],
          'timezone':settings()['timezone'],'source_timezone':'America/Chicago',
          'source_sha256':digest(raw),'source_git_commit':export_revision(scenario,revision),'generator_version':'ops-1.0',
          'config_sha256':digest(canonical(prices)), 'provider':'generated',
          'floors':40,'zones':list(ZONES),'tariff':prices,'rules':RULES,
          'floor_height_m':FLOOR_HEIGHT_M,'max_speed_m_s':MAX_SPEED_M_S,
          'acceleration_m_s2':ACCELERATION_M_S2,'motion':'trapezoidal_acceleration',
          'precision':{'power':1,'energy':1,'temperature':1,'people':0,'ppm':0,'percent':1},
          'units':{'power':'kW','energy':'kWh','temperature':'°C','people':'person',
                   'co2':'ppm','fresh_air':'m³/h','pm25':'μg/m³','solar':'W/m²',
                   'offset':'ms','percent':'%'},
          'connections':[{'system':name,'connected':False,'provider':'generated'}
                         for name in ('BA','BMS','EMS','lift','IoT')]}
    return {'schema_version':'1.0','kind':'day','day_start_ms':0,'meta':meta,'hours':rows,
            'elevators':lifts,'alerts':alerts,'work_orders':orders,'agent_order_refs':refs,
            'history':history,'summary':{'energy_kwh':totals,
             'cost_cny':decimal1(sum(r['energy']['hour_cost_cny'] for r in rows))}}


class GeneratedOpsSource:
    """Read immutable export bytes from the shared stat-keyed cache."""
    def __init__(self, root=None):
        self.root = root or ROOT/'exports/replay'

    def read_day(self,key):
        from .source import read_export
        if key.scenario not in SCENARIOS:
            raise ValueError('unknown scenario')
        data=json.loads(read_export(self.root/(key.scenario+'.ops.json')))
        meta=data['meta']
        if meta['source_date']!=key.source_date.isoformat() or meta['building_id']!=key.building_id:
            raise ValueError('source identity mismatch')
        return data

    def read_floors(self,key,meta):
        from .source import read_export
        name=key.scenario+'.ops-floors.json'
        if meta['floors_file']!=name:
            raise ValueError('invalid floor filename')
        raw=read_export(self.root/name)
        if digest(raw)!=meta['floors_sha256']:
            raise RuntimeError('floor digest mismatch')
        part=json.loads(raw)
        if part['scenario']!=key.scenario or part['source_date']!=meta['source_date']:
            raise ValueError('floor identity mismatch')
        return part

    def connections(self,key):
        return self.read_day(key)['meta']['connections']
