"""Source-date functions for staffing, zones and environmental fields."""
import math
from .config import decimal1, keyed, allocate, HOUR_MS, ZONES


def relative_humidity(dew, indoor, active):
    if dew is None or indoor is None:
        return None
    rh = 100*math.exp(17.625*dew/(243.04+dew)-17.625*indoor/(243.04+indoor))
    return decimal1(max(40.,min(65.,rh)) if active else max(0.,min(100.,rh)))


def floor_rows(source_date, h, source, uses):
    weights = source['floors_kw']
    actuals = allocate(source['actual_kw'],weights)
    outdoor = source.get('outdoor_temp_c')
    setpoint = source.get('agent',{}).get('hvac_setpoint_c',25.5)
    sun = decimal1(700*max(0.,math.sin(math.pi*(h-6)/12)))
    schedule = (.03 if h<6 or h>=22 else .2 if h in (6,21) else .55 if h in (7,20)
                else .9 if h in (8,9,17,18) else .7 if h in (12,13) else 1.)
    if __import__('datetime').date.fromisoformat(source_date).weekday()>=5 or source_date.endswith('-07-04'):
        schedule *= .3
    rows = []
    for i,use in enumerate(uses):
        capacity = {'equipment':4,'garden':38,'lobby':62,'office':115}[use]
        occupancy = round(capacity*schedule*(.85+.15*keyed(source_date,f'floor-{i+1}',h)))
        if use=='equipment':
            occupancy = 4 if 8<=h<18 else 1
        lighting = decimal1(max(8.,min(100.,12+occupancy/capacity*88-sun/80)))
        fresh = occupancy*30
        co2 = round(420+occupancy*3.6)
        zones = []
        for z,name in enumerate(ZONES):
            solar_gain = sun/700*(.4,.8,1.2,1.6,.9,.6)[z]
            weather_gain = 0 if outdoor is None else (outdoor-setpoint)*.045
            temp = decimal1(setpoint-.6+solar_gain+weather_gain+occupancy/capacity*.7+weights[i]/150)
            fan = decimal1(max(15.,min(100.,22+occupancy/capacity*45+max(0,temp-setpoint)*14+z*2)))
            zones.append({'id':name,'temp_c':temp,'fan_pct':fan})
        mean = decimal1(sum(z['temp_c'] for z in zones)/6)
        rows.append({'floor':i+1,'use':use,'floor_kw':weights[i],'floor_actual_kw':actuals[i],
                     'occupancy_people':occupancy,'lighting_pct':lighting,'fresh_air_m3_h':fresh,
                     'co2_ppm':co2,'fan_pct':decimal1(sum(z['fan_pct'] for z in zones)/6),
                     'mean_temp_c':mean,'zones':zones})
    return rows,sun,setpoint


def environment(source_date, h, source, floors):
    mean = decimal1(sum(f['mean_temp_c'] for f in floors)/len(floors))
    active = (source.get('hvac_electric_estimate_kw') or 0)>0
    weather = source.get('weather',{})
    return {'people':sum(f['occupancy_people'] for f in floors),
            'co2_ppm':round(sum(f['co2_ppm'] for f in floors)/len(floors)),
            'indoor_temp_c':mean,'outdoor_temp_c':source.get('outdoor_temp_c'),
            'relative_humidity_pct':relative_humidity(weather.get('dew_temp_c'),mean,active),
            'pm25_ug_m3':decimal1(10+keyed(source_date,'pm25',h)*12),
            'humidity_basis':'dewpoint_at_indoor_temperature; active_hvac_bound_40_65'}


def end_uses(source,h,floors,lifts):
    total = source['actual_kw']
    hvac = source.get('hvac_electric_estimate_kw')
    if hvac is None or not 0<=hvac<=total:
        raise ValueError('HVAC evidence unavailable or outside total')
    left = decimal1(total-hvac)
    # Lift demand includes distance, passengers and standby, then bounded by budget.
    raw_lift = 6*.25+sum(abs(t['to_floor']-t['from_floor'])*(.005+.0003*t['passengers'])
                         for lift in lifts for t in lift['trips'] if h*HOUR_MS<=t['depart_ms']<(h+1)*HOUR_MS)
    lift_kw = min(left,decimal1(raw_lift))
    light_weight = sum(f['lighting_pct'] for f in floors)
    plug_weight = sum(f['occupancy_people'] for f in floors)*1.2
    light,plug,other = allocate(decimal1(left-lift_kw),[light_weight,plug_weight,1000])
    return {'hvac_electric_estimate_kw':hvac,'lighting_kw':light,'plug_kw':plug,
            'elevator_kw':lift_kw,'other_kw':other}
