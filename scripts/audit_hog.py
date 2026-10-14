"""Audit every Hog electricity meter for 2016/17 without imputing missing values."""
from pathlib import Path
import pandas as pd


def audit():
    root = Path('data/raw/bdg2')
    meta = pd.read_csv(root/'metadata.csv')
    hog = meta[meta.site_id.eq('Hog')].copy()
    cols = pd.read_csv(root/'electricity_cleaned.csv', nrows=0).columns
    ids = [b for b in hog.building_id if b in cols]
    e = pd.read_csv(root/'electricity_cleaned.csv',usecols=['timestamp']+ids)
    records=[]
    for b in hog.building_id:
        m = hog[hog.building_id.eq(b)].iloc[0]
        if b not in e:
            records.append(dict(building_id=b, primary_use=m.primaryspaceusage, sqm=m.sqm,
                missing_2016=1.,missing_2017=1.,zero_2016=None,zero_2017=None,
                eligible_2017=False,reason='meter_absent'))
            continue
        s16=e.loc[e.timestamp.str.startswith('2016'),b]
        s17=e.loc[e.timestamp.str.startswith('2017'),b]
        miss16,miss17=float(s16.isna().mean()),float(s17.isna().mean())
        zero16,zero17=float((s16==0).mean()),float((s17==0).mean())
        reasons=[]
        if str(m.electricity).lower()!='yes': reasons.append('metadata_not_electricity')
        if 'parking' in str(m.primaryspaceusage).lower(): reasons.append('parking')
        if miss17 > .05: reasons.append('missing_2017_gt5pct')
        if zero17 > .25: reasons.append('zero_2017_gt25pct')
        records.append(dict(building_id=b,primary_use=m.primaryspaceusage,sqm=m.sqm,
            missing_2016=miss16,missing_2017=miss17,zero_2016=zero16,zero_2017=zero17,
            eligible_2017=not reasons,reason=';'.join(reasons)))
    frame=pd.DataFrame(records).sort_values('building_id')
    out=Path('experiments/hog_quality.csv'); frame.to_csv(out,index=False)
    print('metadata',len(frame),'meter_columns',len(ids),'eligible_2017',int(frame.eligible_2017.sum()))
    print('reason_counts',frame.reason.value_counts().head(12).to_dict())
    print('Byron',frame.loc[frame.building_id.eq('Hog_office_Byron')].to_dict('records'))
    print('2017_missing_gt0',int((frame.missing_2017>0).sum()),'zero_gt25pct',int((frame.zero_2017>.25).sum()))
    return frame


if __name__=='__main__': audit()
