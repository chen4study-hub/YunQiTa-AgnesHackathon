"""BDG2 hourly thermal meters + explicit electrical attribution assumptions, no test fit."""
import json
import math
from datetime import datetime,timedelta
from pathlib import Path
import numpy as np
import pandas as pd
from scripts.download_bdg2_thermal import sha

BUILDING='Hog_office_Byron'
ESTIMATED_FIELDS=['energy_summary.hvac_electric_estimated_share','energy_summary.hvac_electric_estimate_kwh','hvac_electric_estimate_kw','hvac_electric_estimated_share','floors_hvac_electric_estimate_kw','floors_non_hvac_estimate_kw','hvac.thermal_kw','hvac.effective_readings','forecast_24h.hvac','forecast_24h.hvac_electric_estimate_kw','forecast_24h.hvac_electric_estimated_share','forecast_24h.floors_hvac_electric_estimate_kw','forecast_24h.floors_non_hvac_estimate_kw']
ENGINEERING=json.loads(Path(__file__).resolve().parents[2].joinpath('experiments/hvac_auxiliary_v2_plan.json').read_text())['engineering_parameters']


def auxiliary_fraction(season):
    p=ENGINEERING
    fan=p['air_handled_thermal_fraction']*p['fan_pressure_pa']/(p['air_density_kg_m3']*p['air_cp_j_kg_k']*p[season+'_air_delta_k']*p['fan_total_efficiency'])
    pump=p['pump_head_pa']*p['pump_shaft_w_per_flow_head']/(p['pump_motor_efficiency']*p['water_density_kg_m3']*p['water_cp_j_kg_k']*p[season+'_water_delta_k'])
    return fan+pump


ASSUMPTIONS=dict(method_version='building_auxiliary_thermal_v2',cooling_cop=None,cooling_auxiliary_electric_fraction=auxiliary_fraction('cooling'),steam_auxiliary_electric_fraction=auxiliary_fraction('heating'),engineering_parameters=ENGINEERING,interval_hours=1.0,max_past_gap_hours=24,
    cooling_months=[6,7,8,9],heating_months=[11,12,1,2,3],shoulder_months=[4,5,10],
    policy='district production excluded; cooling:cold*derivedfanpumpfactor; heating:steam*derivedfanpumpfactor; shoulder:sum; no compressor or boiler electricity; not measured electrical submeter',
    cap='current:min(actual_kw,point_kw); future:point_kw only, no future measured electricity',
    future='thermal readings held from origin; mode switches by known target month; no target-time meters',
    missing='past-only last valid reading within24h, else null; missing not zero; seasonal inactive meter not needed',
    share_denominator='current:actual_kw; future:point_kw; null for absent estimate or zero denominator',
    units='raw meters:kWh thermal per1h; thermal_kw:kW thermal; electric estimates:kW electrical; share:fraction0-1',
    floor_partition='HVAC estimate is a subset of existing predicted electric floors; exact0.1kW bounded largest remainder, no double counting',
    unit_source='https://github.com/buds-lab/building-data-genome-project-2/wiki/Meters-data-features')


def load_meters(root=Path('data/raw/bdg2'),manifest=Path('experiments/bdg2_thermal_sources.json')):
    lock=json.loads(Path(manifest).read_text());tables={};receipts={}
    for name,spec in lock['files'].items():
        path=Path(root)/name;digest=sha(path)
        if path.stat().st_size!=spec['bytes'] or digest!=spec['sha256']:raise ValueError('Thermal source integrity failed: '+name)
        frame=pd.read_csv(path,usecols=['timestamp',BUILDING]);time=pd.to_datetime(frame.timestamp)
        if time.duplicated().any() or not time.is_monotonic_increasing:raise ValueError('Unordered/duplicate thermal timestamps')
        values=pd.to_numeric(frame[BUILDING],errors='raise');valid=values.notna() & np.isfinite(values) & values.ge(0)
        tables[name.split('_')[0]]=pd.Series(values.where(valid).to_numpy(),index=time)
        receipts[name]=dict(sha256=digest,bytes=path.stat().st_size,pointer_url=spec['pointer_url'])
    return tables,receipts


def origin_readings(t,tables):
    wall=datetime.fromisoformat(t).replace(tzinfo=None);out={}
    for meter,series in tables.items():
        v=series.get(wall,float('nan'));value=float(v) if pd.notna(v) and math.isfinite(v) and v>=0 else None
        known=series.loc[(series.index<=wall)&(series.index>=wall-timedelta(hours=24))].dropna()
        effective=float(known.iloc[-1]) if len(known) else None;source=known.index[-1] if len(known) else None
        out[meter]=dict(raw_kwh=value,effective_kwh=effective,source_wall_time=source.isoformat() if source is not None else None,
            age_hours=(wall-source).total_seconds()/3600 if source is not None else None)
    return out


def partition(floors,hvac_kw):
    if hvac_kw is None:return None,None
    units=np.rint(np.array(floors)*10).astype(int);total=int(units.sum());amount=round(hvac_kw*10)
    if amount<0 or amount>total:raise ValueError('HVAC subset exceeds electric floor total')
    if not total:subset=np.zeros(len(units),dtype=int)
    else:
        weights=units/total*amount;subset=np.floor(weights).astype(int)
        eligible=np.where(subset<units)[0];order=eligible[np.argsort(-(weights-subset)[eligible],kind='stable')]
        for i in order[:amount-int(subset.sum())]:subset[i]+=1
    assert int(subset.sum())==amount and np.all(subset<=units)
    return (subset/10).tolist(),((units-subset)/10).tolist()


def estimate(readings,target,total,actual=None,origin=None):
    month=datetime.fromisoformat(target).month
    mode='cooling' if month in ASSUMPTIONS['cooling_months'] else 'heating' if month in ASSUMPTIONS['heating_months'] else 'shoulder'
    needed=['chilledwater'] if mode=='cooling' else ['steam'] if mode=='heating' else ['chilledwater','steam']
    available=all(readings[k]['effective_kwh'] is not None for k in needed)
    if available:
        thermal=sum(readings[k]['effective_kwh'] for k in needed)
        electric=sum(readings[k]['effective_kwh']*ASSUMPTIONS['cooling_auxiliary_electric_fraction' if k=='chilledwater' else 'steam_auxiliary_electric_fraction'] for k in needed)
        bound=min(total,actual) if actual is not None else total
        # Export0.1precision; rounding bound respects actual/floor totals already at0.1kW.
        capped=min(round(electric,1),math.floor(bound*10+1e-7)/10)
    else:thermal=electric=capped=None
    return dict(season=mode,thermal_kw=round(thermal,1) if thermal is not None else None,
        uncapped_electric_estimate_kw=round(electric,1) if electric is not None else None,cap_applied=bool(available and electric>bound),
        effective_readings=readings,quality='missing' if not available else 'past_fill' if any(readings[k]['age_hours']>0 for k in needed) else 'observed',
        basis='persistence_at_origin' if origin else 'current_or_past_meter',origin=origin),capped


def attach_hvac(data,sources):
    tables,receipts=sources;data['schema_version']='1.3'
    data['meta']['hvac_method']=ASSUMPTIONS;data['meta']['thermal_sources']=receipts
    data['meta']['estimated_fields']=list(dict.fromkeys(data['meta']['estimated_fields']+ESTIMATED_FIELDS))
    for row in data['hours']:
        readings=origin_readings(row['t'],tables)
        row['hvac'],electric=estimate(readings,row['t'],row['point_kw'],row['actual_kw'])
        assign(row,electric,row['actual_kw'])
        for p in row['forecast_24h']:
            p['hvac'],electric=estimate(readings,p['t'],p['point_kw'],origin=row['t'])
            assign(p,electric,p['point_kw'])
    known=[r for r in data['hours'] if r['hvac_electric_estimate_kw'] is not None]
    electricity=sum(r['actual_kw'] for r in known);hvac=sum(r['hvac_electric_estimate_kw'] for r in known)
    data['energy_summary']=dict(hvac_electric_estimate_kwh=round(hvac,1) if known else None,
        matched_building_electric_kwh=round(electricity,1) if known else None,
        hvac_electric_estimated_share=round(hvac/electricity,6) if electricity>0 else None,
        valid_hours=len(known),total_hours=len(data['hours']),cap_applied_hours=sum(r['hvac']['cap_applied'] for r in known),
        past_fill_hours=sum(r['hvac']['quality']=='past_fill' for r in known),
        denominator='sum of actual_kw across matched valid hours,1h intervals; not mean hourly share',
        label='空调电耗占比（估算）')
    return data


def assign(row,electric,denominator):
    row['hvac_electric_estimate_kw']=electric
    row['hvac_electric_estimated_share']=round(electric/denominator,6) if electric is not None and denominator>0 else None
    row['floors_hvac_electric_estimate_kw'],row['floors_non_hvac_estimate_kw']=partition(row['floors_kw'],electric)
