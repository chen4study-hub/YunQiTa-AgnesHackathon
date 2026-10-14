"""Save observed data quality, caps and declared proxy limits; no new forecasting evaluation."""
import json
from pathlib import Path
from src.data.hvac import load_meters,ASSUMPTIONS


def main():
    tables,receipts=load_meters();quality={k:dict(rows=len(s),valid=int(s.notna().sum()),missing=int(s.isna().sum()),minimum=float(s.min()),maximum=float(s.max())) for k,s in tables.items()}
    summaries={name:json.loads(Path(f'exports/replay/{name}.json').read_text(encoding='utf-8'))['energy_summary'] for name in ['normal','peak','abstain']}
    from src.agent.display_text import wording_text
    for summary in summaries.values():
        summary['label']=wording_text(summary['label'])
    report=dict(schema_version='1.4',building_id='Hog_office_Byron',sources=receipts,quality=quality,assumptions=ASSUMPTIONS,scenarios=summaries,
        new_model_fit=False,new_2017_forecast_evaluation=False,thermal_export_llm_calls=0,task_scheduler_used=False,environment_or_config_changed=False,
        development_artifact='experiments/hvac_auxiliary_v2_development.json',
        limits=['building auxiliaries only, district production excluded by assumption not verified meter boundary','fixed EnergyPlus-based equations; coil/fan values scenario assumptions not measured Byron HVAC','2016plausibility screen not true end-use validation or published office percentile interval','futurethermal originpersistence, no calibratedforecast','floorpartition measured HVAC unavailable; model allocation only'])
    Path('experiments/hvac_integration.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    path=Path('exports/model_card.json');card=json.loads(path.read_text(encoding='utf-8'))
    card['hvac_attribution']={'contract_version':'1.4','report':'experiments/hvac_integration.json','method':'docs/hvac_meter_contract.md','assumptions':ASSUMPTIONS,
        'measured_electrical_hvac':False,'calibrated_counterfactual_savings':False,'typical_day_summaries':summaries}
    path.write_text(json.dumps(card,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf-8')
    print(json.dumps({'schema_version':'1.4','quality':quality,'summaries':summaries},ensure_ascii=True))


if __name__=='__main__':main()
