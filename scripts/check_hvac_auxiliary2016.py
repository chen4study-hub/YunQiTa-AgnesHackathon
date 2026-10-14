"""Single preregistered engineering proxy: physically clip2016before plausibility check."""
import json
from pathlib import Path
import pandas as pd
from src.data.hvac import load_meters,origin_readings,estimate,ASSUMPTIONS
from scripts.download_bdg2_thermal import sha

PLAN=Path('experiments/hvac_auxiliary_v2_plan.json');OUT=Path('experiments/hvac_auxiliary_v2_development.json')


def main():
    if OUT.exists():raise FileExistsError('Frozen development evidence; no overwrite')
    plan=json.loads(PLAN.read_text());tables,receipts=load_meters();tables={k:s.loc[s.index.year==2016].copy() for k,s in tables.items()}
    e=pd.read_csv('data/raw/bdg2/electricity_cleaned.csv',usecols=['timestamp','Hog_office_Byron']);e['timestamp']=pd.to_datetime(e.timestamp);e=e[e.timestamp.dt.year==2016]
    rows=[]
    for r in e.itertuples(index=False):
        if pd.isna(r.Hog_office_Byron) or r.Hog_office_Byron<=0:continue
        t=r.timestamp.isoformat();h,value=estimate(origin_readings(t,tables),t,float(r.Hog_office_Byron),float(r.Hog_office_Byron))
        if value is None:continue
        rows.append(dict(month=r.timestamp.month,electricity=float(r.Hog_office_Byron),raw=h['uncapped_electric_estimate_kw'],cap=h['cap_applied'],share=h['uncapped_electric_estimate_kw']/float(r.Hog_office_Byron)))
    d=pd.DataFrame(rows)
    def summary(g):return dict(n=len(g),pooled_uncapped_share=float(g.raw.sum()/g.electricity.sum()),median_share=float(g.share.median()),p05_share=float(g.share.quantile(.05)),p95_share=float(g.share.quantile(.95)),max_share=float(g.share.max()),cap_n=int(g.cap.sum()),cap_fraction=float(g.cap.mean()))
    stats=summary(d);gate=plan['dev_gate'];passed=gate['pooled_share_min']<=stats['pooled_uncapped_share']<=gate['pooled_share_max'] and stats['cap_fraction']<=gate['max_uncapped_fraction_ge_one']
    result=dict(status='passed' if passed else 'failed',year=2016,final_year_used_for_selection=False,plan_sha256=sha(PLAN),assumptions=ASSUMPTIONS,sources=receipts,
        maximum_input_timestamp=str(e.timestamp.max()),summary=stats,months={str(m):summary(g) for m,g in d.groupby('month')},parameters_retuned=False,code_sha256=sha('src/data/hvac.py'))
    OUT.write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result,indent=2))
    if not passed:raise SystemExit(2)


if __name__=='__main__':main()
