"""Export measured replay metrics; product confidence is not nominal coverage."""
import json
from pathlib import Path
import pandas as pd
from src.conformal.replay_calibration import summary
from scripts.evaluate_transfer_current import model_card_transfer_fields


def main():
    index=json.loads(Path('experiments/demo_monthly_index.json').read_text(encoding='utf-8'))
    s=index['pooled_full_year']
    card=dict(model_version=index['version'],retained_coverage=s['retained_picp'],target_coverage=.905,
        cross_building_coverage=None,rejection_rate=s['rejection_rate'],retained_mae=s['retained_mae'],
        all_sample_mae=s['all_mae'],evaluation='2017 Jan-Dec8760 pooled hourly monthly rolling predictions; coverage is total retained hits/total retained hours, not mean of monthly PICP',
        cross_building_context='Not measured for this expanded holiday monthly model; do not reuse old Robin transfer results',
        comparison_apr_dec_pooled=index['pooled_apr_dec'],
        confidence_definition='99% past-only isotonic risk-bin empirical coverage +1% inverse-risk tie-break; complete rejection gate penalty; display score not calibrated probability',
        coverage_target_met=s['retained_picp']>=.905,dispatch_transport='log_only',device_connected=False,
        synthetic_fields=['storage','pv','grid_kw'],estimated_fields=['floors_kw'],
        holiday_feature_enabled=True,holiday_post_route=index['version'])
    path=Path('exports/model_card.json')
    if path.exists():card={**json.loads(path.read_text(encoding='utf-8')),**card}
    daily=Path('experiments/round78_calibration.json')
    if daily.exists():
        receipt=json.loads(daily.read_text(encoding='utf-8'));s=receipt['pooled']
        card.update(retained_coverage=s['retained_coverage'],rejection_rate=s['rejection_rate'],retained_mae=s['retained_mae'],all_sample_mae=s['mae'],coverage_target_met=s['retained_coverage']>=.905,
            calibration_method=receipt['version'],calibration_building=receipt['building'],calibration_window_days=10,cold_start_enabled=False,
            evaluation='2017 Jan-Dec8760 pooled hourly; daily past10 completed observations, monthly point frozen',
            comparison_apr_dec_pooled=receipt['april_dec'],daily_calibration_receipt=str(daily),baseline_monthly=receipt['baseline_pooled'])
        if 'multi_horizon' in card:
            card['multi_horizon'].update(calibration_method=receipt['version'],metrics_by_horizon=receipt['multi_metrics'],confidence=receipt['confidence'],evaluation='2017 monthly frozen point experts; daily per-horizon calibration using only completed targets before origin day',coverage_target_met_any_horizon=any(m['retained_coverage']>=.905 for m in receipt['multi_metrics']))
    card.update(model_card_transfer_fields(index['version']))
    path.write_text(json.dumps(card,indent=2),encoding='utf-8')


if __name__=='__main__':main()
