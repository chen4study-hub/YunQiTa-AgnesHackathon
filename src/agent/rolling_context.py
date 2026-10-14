"""Current execution hour plus origin-issued h1..h23, never future observed weather."""
from datetime import datetime,timedelta
from .tools import tool_config


def rolling_inputs(building_id,current,future,origin_weather,soc,current_pv):
    predictions=[current]+future[:23]
    if len(predictions)!=24:raise ValueError('Need complete origin-issued forecast_24h')
    start=datetime.fromisoformat(current['timestamp']);cfg=tool_config();tariff=cfg['tariff'];hours=[]
    for i,p in enumerate(predictions):
        t=datetime.fromisoformat(p['timestamp'])
        if t!=start+timedelta(hours=i):raise ValueError('Rolling hourly alignment required')
        hour=t.astimezone(start.tzinfo).hour
        period='valley' if hour in tariff['valley_hours'] else 'peak' if hour in tariff['peak_hours'] else 'flat'
        # Known current PV only; future zero is conservative, not future cloud lookahead.
        hours.append(dict(timestamp=p['timestamp'],outdoor_temp_c=origin_weather,storage_soc=soc,
            pv_kw=current_pv if i==0 else 0.,price_per_kwh=tariff[period],tariff_period=period,
            source='origin weather persistence; current known PV, future zero PV; configured tariff'))
    return {'building_id':building_id,'predictions':predictions},{'hours':hours},{**cfg['equipment'],'initial_soc':soc}


def from_replay(data,row,soc):
    current=dict(timestamp=row['t'],point=row['point_kw'],lower=row['lower_kw'],upper=row['upper_kw'],
        confidence=row['confidence'],abstain=row['abstain'],abstain_reason=row['abstain_reason'],
        risk_score=row['risk_score'],risk_threshold=row['risk_threshold'])
    future=[dict(timestamp=p['t'],point=p['point_kw'],lower=p['lower_kw'],upper=p['upper_kw'],
        confidence=p['confidence'],abstain=p['abstain'],abstain_reason=p.get('abstain_reason') or ('forecast_gate_refused' if p['abstain'] else None),
        risk_score=p['risk_score'],risk_threshold=p['risk_threshold']) for p in row['forecast_24h']]
    f,c,k=rolling_inputs(data['meta']['building_id'],current,future,row['outdoor_temp_c'],soc,row['pv']['power_kw'])
    c['hours'][0].update(floors_kw=row['floors_kw'],floor_uses=data['meta']['floor_uses'],actual_kw=row['actual_kw'])
    for h in c['hours'][1:]:h['floor_uses']=data['meta']['floor_uses']
    return f,c,k
