"""2017 Hog actual electricity + site weather; exact contiguous hourly meters only."""
from pathlib import Path
import pandas as pd


def prepare(max_buildings=85):
    root=Path('data/raw/bdg2')
    q=pd.read_csv('experiments/hog_quality.csv')
    eligible=q[(q.eligible_2017)&(q.missing_2017==0)].sort_values('building_id')
    ids=eligible.building_id.tolist()
    ids=[b for b in ids if b!='Hog_office_Byron']
    ids=['Hog_office_Byron']+ids[:max(0,max_buildings-1)]
    matrix=pd.read_csv(root/'electricity_cleaned.csv',usecols=['timestamp']+ids)
    matrix=matrix[matrix.timestamp.str.startswith('2017')]
    if len(matrix)!=8760 or matrix[ids].isna().any().any(): raise ValueError('missing load in 2017 cohort')
    long=matrix.melt(id_vars='timestamp',var_name='building_id',value_name='meter_reading')
    meta=pd.read_csv(root/'metadata.csv')[['building_id','site_id','primaryspaceusage','sqm']]
    long=long.merge(meta,on='building_id',validate='many_to_one')
    weather=pd.read_csv(root/'weather.csv',usecols=['timestamp','site_id','airTemperature','cloudCoverage'])
    weather=weather[weather.timestamp.str.startswith('2017')]
    if weather.duplicated(['timestamp','site_id']).any():raise ValueError('ambiguous site weather')
    long=long.merge(weather,on=['timestamp','site_id'],how='left',validate='many_to_one')
    long=long.rename(columns={'primaryspaceusage':'primary_use','airTemperature':'air_temperature','cloudCoverage':'cloud_coverage'})
    # Raw wall-clock values relabeled UTC only for existing 1-step feature adapter.
    long['timestamp']=pd.to_datetime(long.timestamp,utc=True).dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    out=Path('data/hog2017_cohort.csv');long.to_csv(out,index=False)
    long[long.building_id.eq('Hog_office_Byron')].to_csv('data/byron2017.csv',index=False)
    print({'rows':len(long),'buildings':len(ids),'main':'Hog_office_Byron',
           'weather_missing':int(long.air_temperature.isna().sum()),'output':str(out)})


if __name__=='__main__': prepare()
