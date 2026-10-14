"""Descriptive h3-h4 seams; does not alter predictions or choose smoothing."""
import json
from pathlib import Path
import numpy as np
import pandas as pd


def main():
    actual=pd.read_csv('data/raw/bdg2/electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron']).set_index('timestamp').Hog_office_Byron
    results={}
    for name in ['normal','peak','abstain']:
        data=json.loads(Path(f'exports/replay/{name}.json').read_text(encoding='utf-8'));rows=[]
        for r in data['hours']:
            p=r['forecast_24h']
            rows.append(dict(origin=r['t'],h3_t=p[2]['t'],h4_t=p[3]['t'],h3_kw=p[2]['point_kw'],h4_kw=p[3]['point_kw'],
                delta34=round(p[3]['point_kw']-p[2]['point_kw'],1),delta23=round(p[2]['point_kw']-p[1]['point_kw'],1),
                delta45=round(p[4]['point_kw']-p[3]['point_kw'],1),relative_delta34=abs(p[3]['point_kw']-p[2]['point_kw'])/max(1,p[2]['point_kw'])))
        for r in rows:
            r['actual_delta34']=round(float(actual.loc[r['h4_t'][:10]+' '+r['h4_t'][11:19]])-float(actual.loc[r['h3_t'][:10]+' '+r['h3_t'][11:19]]),1)
        largest=max(rows,key=lambda r:abs(r['delta34']))
        results[name]=dict(max_abs_delta34=abs(largest['delta34']),median_abs_delta34=float(np.median([abs(r['delta34']) for r in rows])),
            median_abs_delta23=float(np.median([abs(r['delta23']) for r in rows])),median_abs_delta45=float(np.median([abs(r['delta45']) for r in rows])),
            largest=largest,rows=rows)
    Path('experiments/horizon_seam_diagnosis.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    print(json.dumps({k:{n:v for n,v in r.items() if n!='rows'} for k,r in results.items()},indent=2))


if __name__=='__main__':main()
