"""Document measured metadata vs estimated tower layout and simulation assumptions."""
import json
from pathlib import Path
import pandas as pd
from scripts.export_replay import USES, MAIN, REPLAY


def main():
    q=pd.read_csv('experiments/hog_quality.csv')
    meta=pd.read_csv('data/raw/bdg2/metadata.csv').set_index('building_id')
    out=[]
    for row in q.itertuples():
        m=meta.loc[row.building_id]
        complete=bool(row.eligible_2017 and row.missing_2017==0)
        ismain=row.building_id==MAIN
        record={'building_id':row.building_id,'display_name':'云栖塔' if ismain else row.building_id,
                'site_id':'Hog','primary_use':str(row.primary_use),
                'sqm':round(float(row.sqm),1) if pd.notna(row.sqm) else None,
                'sqm_source':'BDG2_metadata','timezone':'America/Chicago',
                'replay_included':complete,'exclusion_reason':None if complete else
                 (str(row.reason) if pd.notna(row.reason) else 'incomplete_2017_no_imputation'),
                'electricity_source':'BDG2_cleaned_hourly','chilledwater_available_in_metadata':str(m.chilledwater).lower()=='yes',
                'chilledwater_file_loaded':False}
        if ismain:
            record.update(floors=40,floors_source='estimated_from_area',floor_uses=USES,
                          floor_area_sqm=round(float(row.sqm)/40,1),
                          storage={'source':'simulated',**REPLAY['storage']},
                          pv={'source':'simulated',**REPLAY['pv']},mode='shadow')
        out.append(record)
    Path('exports/buildings.json').write_text(json.dumps(out,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf-8')
    print('exported metadata',len(out))


if __name__=='__main__':main()
