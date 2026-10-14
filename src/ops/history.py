"""Saved prior-day meter evidence, not wrapped current-day hours."""
from datetime import datetime,timedelta
from functools import lru_cache
from .config import ROOT, allocate, decimal1, digest


@lru_cache(maxsize=8)
def meter_frame(path_text,building,size,modified):
    import pandas as pd
    path=__import__('pathlib').Path(path_text)
    if building=='weather':
        frame=pd.read_csv(path,usecols=['timestamp','site_id','airTemperature','dewTemperature'])
        frame=frame[frame.site_id.eq('Hog')].set_index('timestamp')
    else:
        frame=pd.read_csv(path,usecols=['timestamp',building]).set_index('timestamp')[building]
    return frame,digest(path.read_bytes())


def load_frame(path,building):
    info=path.stat()
    return meter_frame(str(path),building,info.st_size,info.st_mtime_ns)


def prior_sources(data):
    import pandas as pd
    building = data['meta']['building_id']
    start = datetime.fromisoformat(data['meta']['date'])
    targets = [start+timedelta(hours=h) for h in range(-6,0)]
    names = ('electricity','chilledwater','steam')
    frames, hashes = {}, {}
    for name in names:
        path = ROOT/'data/raw/bdg2'/(name+'_cleaned.csv')
        frames[name],hashes[name] = load_frame(path,building)
    path = ROOT/'data/raw/bdg2/weather.csv'
    weather,hashes['weather'] = load_frame(path,'weather')
    method = data['meta']['hvac_method']
    result=[]
    for target in targets:
        key=target.strftime('%Y-%m-%d %H:%M:%S')
        total=decimal1(float(frames['electricity'].loc[key]))
        needed = ['chilledwater'] if target.month in method['cooling_months'] else ['steam'] if target.month in method['heating_months'] else ['chilledwater','steam']
        electric=0.
        for meter in needed:
            past=frames[meter].loc[(frames[meter].index<=key)&(frames[meter].index>=(target-timedelta(hours=24)).strftime('%Y-%m-%d %H:%M:%S'))].dropna()
            if past.empty: raise ValueError('prior HVAC meter unavailable')
            coefficient=method['cooling_auxiliary_electric_fraction' if meter=='chilledwater' else 'steam_auxiliary_electric_fraction']
            electric+=float(past.iloc[-1])*coefficient
        w=weather.loc[key]
        result.append({'t':target.isoformat(),'actual_kw':total,'point_kw':None,
                       'floors_kw':allocate(total,data['hours'][0]['floors_kw']),
                       'hvac_electric_estimate_kw':min(total,decimal1(electric)),
                       'outdoor_temp_c':None if pd.isna(w.airTemperature) else decimal1(w.airTemperature),
                       'weather':{'dew_temp_c':None if pd.isna(w.dewTemperature) else decimal1(w.dewTemperature)},
                       'agent':{'hvac_setpoint_c':25.5},'storage':{'soc':None,'power_kw':None},
                       'pv':{'power_kw':None},'grid_kw':None})
    return result,hashes
