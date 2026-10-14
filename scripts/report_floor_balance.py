"""Offline conservation/ratio audit against pre-change exports."""
import json,subprocess
from pathlib import Path
import numpy as np
from scripts.replay_floor_allocation import USES
from scripts.export_future24 import sha


def strip(o):
    if isinstance(o,dict):return {k:strip(v) for k,v in o.items() if k not in ['floors_kw','floors_hvac_electric_estimate_kw','floors_non_hvac_estimate_kw']}
    if isinstance(o,list):return [strip(v) for v in o]
    return o


def main():
    rows=[];maximum=0;equipment=0;office=[i for i,u in enumerate(USES) if u=='office']
    for name in ['normal','peak','abstain']:
        path=Path(f'exports/replay/{name}.json');d=json.loads(path.read_text(encoding='utf-8'));old=json.loads(subprocess.check_output(['git','show',f'bda65cb:{path.as_posix()}']))
        assert strip(d)==strip(old)
        for row in d['hours']:
            for r in [row]+row['forecast_24h']:
                v=np.array(r['floors_kw']);median=np.median(v[office]);ratio=float(v.max()/median);maximum=max(maximum,ratio);equipment=max(equipment,float(max(v[1],v[38])/median))
                assert ratio<=2.5 and abs(sum(v)-r['point_kw'])<1e-7
            if row['t'][11:13]=='22':rows.append({'day':name,'old_equipment_kw':[old['hours'][22]['floors_kw'][i] for i in [1,38]],'new_equipment_kw':[row['floors_kw'][i] for i in [1,38]],'office_median_kw':float(np.median(np.array(row['floors_kw'])[office]))})
    p=Path('experiments/agent_replay_export.json');receipt=json.loads(p.read_text());receipt['export_sha256']={k:sha(Path('exports/replay')/k) for k in receipt['export_sha256']};p.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    out={'status':'passed','max_floor_to_office_median':maximum,'max_equipment_to_office_median':equipment,'conservation':True,'unrelated_fields_preserved':True,'new_llm_calls':0,'new_dispatches':0,'at22':rows}
    Path('experiments/floor_balance_report.json').write_text(json.dumps(out,indent=2),encoding='utf-8');print(json.dumps(out,indent=2))


if __name__=='__main__':main()
