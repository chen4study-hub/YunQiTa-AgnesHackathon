"""Pre-registered current Byron transfer; early-only and online daily10 kept separate."""
import os
for _key in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[_key] = '1'
import copy
import hashlib
import json
import platform
import time
from pathlib import Path
import importlib.metadata
import joblib
import numpy as np
import pandas as pd
from src.data.adapter import adapt
from src.models.residual import ResidualForecaster
from src.conformal.daily_local import prepare, fit_local, metrics
from src.conformal.byron_daily import issued
from scripts.search_byron import fit_quantiles

ROOT = Path('experiments/transfer_current_20261013')
VERSION = 'byron-expanded-holiday-monthly-v1'
PROTOCOLS = ('early_only', 'daily_past10')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf-8')


def estimator_hash(model, quantiles):
    text = ''.join(m.booster_.model_to_string() for m in
                   (model.point_model, model.scale_model, *quantiles))
    return hashlib.sha256(text.encode()).hexdigest()


def single_thread(model, quantiles):
    for m in (model.point_model, model.scale_model, *quantiles):
        m.set_params(n_jobs=1)


def select_calibration(frame, day, plan, protocol):
    """Strict primary never uses a test outcome, even on later test days."""
    test_start = pd.Timestamp(plan['time']['test_start'])
    boundary = test_start if protocol == 'early_only' else pd.Timestamp(day)
    if protocol not in PROTOCOLS:
        raise ValueError('unknown protocol')
    cal = frame[(frame.timestamp >= boundary-pd.Timedelta(days=plan['calibration_days'])) &
                (frame.timestamp < boundary) & frame.y.notna()]
    if len(cal) < plan['minimum_calibration_rows'] or cal.building_id.nunique() != 1:
        raise ValueError('insufficient single-building completed calibration')
    if not cal.timestamp.max() < pd.Timestamp(day):
        raise ValueError('future calibration')
    return cal


def predict_protocol(frame, start, end, cfg, lookup, plan, protocol):
    rows = []
    fixed = None
    if protocol == 'early_only':
        fixed = fit_local(select_calibration(frame, start, plan, protocol), cfg, 'cqr')
    for day in pd.date_range(start, end-pd.Timedelta(days=1), freq='D'):
        ev = frame[(frame.timestamp >= day) & (frame.timestamp < day+pd.Timedelta(days=1))]
        if len(ev) != 24:
            raise ValueError(f'incomplete evaluation day: {day}')
        state = fixed if fixed is not None else fit_local(select_calibration(frame, day, plan, protocol), cfg, 'cqr')
        assert state['cal_end'] < day
        out = issued(ev, state, cfg, lookup)
        # y is used for scoring only after point, interval, gate and confidence fixed.
        out['y'] = ev.y.to_numpy()
        out['hit'] = (out.y >= out.lower) & (out.y <= out.upper)
        out['holiday'] = ev.holiday.to_numpy().astype(bool)
        rows.append(out)
    return pd.concat(rows, ignore_index=True)


def measured(pred):
    result = metrics(pred)
    mean = float(pred.y.mean())
    result.update(mean_load=mean, cv_rmse=result['rmse']/mean if mean > 0 else None,
                  covered_n=int(pred.hit.sum()),
                  retained_covered_n=int(pred.loc[~pred.abstain, 'hit'].sum()))
    return result


def validate_data(data, plan):
    expected = pd.date_range(plan['time']['start'], plan['time']['end_exclusive'], inclusive='left', freq='h')
    for item in plan['buildings']:
        one = data[data.building_id.eq(item['building_id'])]
        if not pd.DatetimeIndex(one.timestamp).equals(expected):
            raise ValueError('target timestamps differ from complete 2017 hourly grid')
        if not np.isfinite(one.y).all() or not one.usage.eq(item['usage']).all():
            raise ValueError('invalid target observations/usage')


def diagnostic_rows(predictions):
    rows = []
    for keys, one in predictions.groupby(['building_id', 'model', 'protocol'], sort=True):
        for label, mask in [('holiday', one.holiday), ('ordinary', ~one.holiday),
                            ('low_load_le_10', one.y <= 10), ('positive_load_gt_10', one.y > 10)]:
            group = one[mask]
            if len(group):
                rows.append(dict(zip(('building_id', 'model', 'protocol'), keys), group=label, **measured(group)))
        for quarter, group in one.groupby(pd.to_datetime(one.timestamp, utc=True).dt.quarter):
            rows.append(dict(zip(('building_id', 'model', 'protocol'), keys), group=f'Q{quarter}', **measured(group)))
    return rows


def run():
    if (ROOT/'results.json').exists():
        raise FileExistsError('immutable evaluation already completed')
    plan_path = ROOT/'plan.json'
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    index = json.loads(Path(plan['source_index']).read_text(encoding='utf-8'))
    assert index['version'] == plan['source_version'] == VERSION
    started = time.monotonic()
    provenance = dict(plan_sha256=sha(plan_path), data_sha256=sha(plan['data']),
                      source_index_sha256=sha(plan['source_index']),
                      script_sha256=sha(__file__), python=platform.python_version(),
                      packages={name: importlib.metadata.version(name) for name in
                                ('numpy', 'pandas', 'lightgbm', 'scikit-learn', 'joblib')})
    artifacts = []
    selected = [item['building_id'] for item in plan['buildings']]
    raw = pd.read_csv(plan['data'])
    raw = raw[raw.building_id.isin(selected)].copy()
    first = joblib.load(index['rows'][0]['artifact'])
    cfg = copy.deepcopy(first['backbone'].cfg)
    cfg['conformal']['rejection_fraction'] = plan['rejection_fraction']
    assert cfg['conformal']['alpha'] == plan['alpha']
    assert cfg['conformal']['max_relative_width'] == plan['max_relative_width']
    data = adapt(raw, cfg)
    validate_data(data, plan)
    t = {k: pd.Timestamp(v) for k, v in plan['time'].items()}
    local = {}
    fits = []
    # Baseline fit completed entirely within the early preparation block.
    for building in selected:
        one = data[data.building_id.eq(building)].copy()
        train = one[one.timestamp < t['self_train_end_exclusive']]
        scale = one[(one.timestamp >= t['self_train_end_exclusive']) &
                    (one.timestamp < t['self_scale_end_exclusive'])]
        model = ResidualForecaster(copy.deepcopy(cfg)).fit(train, scale)
        quantiles = fit_quantiles(model, train)
        single_thread(model, quantiles)
        local[building] = (model, quantiles, prepare(model, one, quantiles), estimator_hash(model, quantiles))
        fits.append(dict(building_id=building, train_n=len(train), train_end=str(train.timestamp.max()),
                         scale_n=len(scale), scale_end=str(scale.timestamp.max()),
                         estimator_sha256=local[building][3]))
    predictions = []
    log_path = ROOT/'run.log'
    with log_path.open('x', encoding='utf-8') as log:
        def record(value):
            text = json.dumps(value, ensure_ascii=False, allow_nan=False)
            log.write(text+'\n'); log.flush(); print(text, flush=True)
        record(dict(event='start', provenance=provenance, selected=selected, self_fits=fits))
        for entry in index['rows']:
            month = entry['month']
            month_start = pd.Timestamp(month+'-01', tz='UTC')
            start = max(month_start, t['test_start'])
            end = min(month_start+pd.offsets.MonthBegin(1), t['end_exclusive'])
            if start >= end:
                continue
            assert sha(entry['artifact']) == entry['artifact_sha256']
            bundle = joblib.load(entry['artifact'])
            assert bundle['version'] == VERSION and bundle['month'] == month
            assert pd.Timestamp(bundle['train_end']) < month_start
            assert pd.Timestamp(bundle['calibration_end']) < month_start
            assert pd.Timestamp(bundle['confidence_validation_end']) < month_start
            model, quantiles = bundle['backbone'], bundle['quantile_models']
            assert model.cfg['features'] == cfg['features'] and model.columns == local[selected[0]][0].columns
            single_thread(model, quantiles)
            frozen = estimator_hash(model, quantiles)
            artifacts.append(dict(month=month, path=entry['artifact'], sha256=entry['artifact_sha256'],
                                  train_end=bundle['train_end'], estimator_sha256=frozen))
            for building in selected:
                one = data[data.building_id.eq(building) & (data.timestamp < end)]
                frames = {'transfer': prepare(model, one, quantiles), 'self_trained': local[building][2]}
                for name, frame in frames.items():
                    for protocol in PROTOCOLS:
                        pred = predict_protocol(frame, start, end, cfg['conformal'],
                                                bundle['confidence_lookup'], plan, protocol)
                        pred['model'] = name; pred['protocol'] = protocol
                        predictions.append(pred)
                        record(dict(event='month', month=month, building_id=building, model=name,
                                    protocol=protocol, metrics=measured(pred),
                                    cal_end_max=str(pred.cal_end.max())))
            assert estimator_hash(model, quantiles) == frozen
        for building in selected:
            model, quantiles, _, frozen = local[building]
            assert estimator_hash(model, quantiles) == frozen
        pred = pd.concat(predictions, ignore_index=True)
        expected_n = int((t['end_exclusive']-t['test_start'])/pd.Timedelta(hours=1))
        rows = []
        for keys, group in pred.groupby(['building_id', 'model', 'protocol'], sort=True):
            assert len(group) == expected_n and group.timestamp.nunique() == expected_n
            assert (group.cal_end < group.timestamp.dt.floor('D')).all()
            if keys[2] == 'early_only':
                assert (group.cal_end < t['test_start']).all()
            rows.append(dict(zip(('building_id', 'model', 'protocol'), keys), **measured(group)))
        pooled = {protocol: {name: measured(pred[pred.protocol.eq(protocol) & pred.model.eq(name)])
                             for name in ('transfer', 'self_trained')} for protocol in PROTOCOLS}
        output = ROOT/'predictions.csv.gz'
        pred.to_csv(output, index=False, compression={'method': 'gzip', 'mtime': 0})
        pd.DataFrame(rows).to_csv(ROOT/'metrics.csv', index=False)
        diagnostics = diagnostic_rows(pred)
        pd.DataFrame(diagnostics).to_csv(ROOT/'diagnostics.csv', index=False)
        result = dict(status='completed', source_version=VERSION, primary_protocol='early_only',
                      selected_buildings=selected, test_start=str(t['test_start']),
                      test_end_exclusive=str(t['end_exclusive']), per_building=rows, pooled=pooled,
                      self_fits=fits, source_artifacts=artifacts, provenance=provenance,
                      predictions_sha256=sha(output), unchanged_estimators=True,
                      no_future_calibration=True, early_only_no_test_labels=True,
                      hourly_past_load_feedback=True, seconds=time.monotonic()-started)
        save_json(ROOT/'results.json', result)
        write_report(result, diagnostics)
        record(dict(event='completed', pooled=pooled, predictions_sha256=result['predictions_sha256']))

def write_report(result, diagnostics):
    lines = ['# 当前 Byron 单步模型跨建筑迁移评测', '',
             '## 协议与边界',
             '- 按元数据预选办公、教育、餐饮、工业、住宿各1栋，并在任何训练/评分前写入 plan.json；未按结果换楼。',
             '- 主评测 early_only：前45天准备，2月5–14日共240小时校准，2月15日–12月31日测试；每个月重算早期校准残差但不使用测试标签。',
             '- daily_past10 单独模拟上线每日校准：仅用发行日之前已完成的10天观测，允许过去测试反馈；不是严格固定校准测试。',
             '- 月度源专家、特征、节假日、CQR、15%风险门控及相对宽度上限1均沿用当前版本；无目标点模型微调、缩放或参数搜索。',
             '- 自训对照仅用1月1–21日训练点/分位数、1月22日–2月4日训练尺度；此后不重训，两种校准政策分别与迁移一致。其训练历史远短于源模型，不能当作全历史自训上界。',
             '- 单步预测允许之前小时的真实负荷构造lag/rolling；天气只用滞后观测，不是全年开环预测。原始BDG2墙上时间沿用UTC标签，kWh/小时等价平均kW。', '',
             '## 每栋结果',
             'CV(RMSE)=RMSE/测试真实均值；表中覆盖、CV及拒绝率均为百分比，MAE单位kWh。通过=同时通过风险与宽度门控。', '']
    for protocol in PROTOCOLS:
        lines += [f'### {protocol}',
                  '|楼宇|模型|全覆盖|MAE|CV(RMSE)|拒绝率|通过覆盖|通过MAE|通过/总数|',
                  '|---|---|---:|---:|---:|---:|---:|---:|---:|']
        for row in result['per_building']:
            if row['protocol'] != protocol:
                continue
            def pct(key):
                return f"{100*row[key]:.2f}%" if row[key] is not None else '未定义'
            kept_mae = f"{row['retained_mae']:.3f}" if row['retained_mae'] is not None else '未定义'
            lines.append(f"|{row['building_id']}|{row['model']}|{pct('all_coverage')}|{row['mae']:.3f}|{pct('cv_rmse')}|{pct('rejection_rate')}|{pct('retained_coverage')}|{kept_mae}|{row['retained_n']}/{row['n']}|")
        for name, row in result['pooled'][protocol].items():
            lines.append(f"- {name} 按样本池化：全覆盖 {row['all_coverage']:.4%}，通过覆盖 {row['retained_coverage']:.4%}，MAE {row['mae']:.3f}，拒绝率 {row['rejection_rate']:.2%}。")
        lines.append('')
    lines += ['## 失效与自训对照（预先定义的阈值，非选楼依据）']
    for building in result['selected_buildings']:
        for protocol in PROTOCOLS:
            tr = next(r for r in result['per_building'] if r['building_id'] == building and r['model'] == 'transfer' and r['protocol'] == protocol)
            base = next(r for r in result['per_building'] if r['building_id'] == building and r['model'] == 'self_trained' and r['protocol'] == protocol)
            flags = []
            if tr['retained_coverage'] is None or tr['retained_coverage'] < .905:
                flags.append('通过覆盖未达90.5%')
            if tr['rejection_rate'] > .3:
                flags.append('拒绝率超过30%')
            if tr['mae'] > base['mae']:
                flags.append('全样本MAE劣于短历史自训')
            lines.append(f"- {building} / {protocol}：{'；'.join(flags) or '未触发上述阈值'}；迁移MAE−自训MAE={tr['mae']-base['mae']:+.3f}；风险拒绝{tr['risk_rejection_rate']:.2%}、宽度拒绝{tr['width_rejection_rate']:.2%}（可重叠）。")
    lines += ['', '### 分组诊断',
              '以下只做事后诊断，不调参、不筛楼；小样本条件覆盖不构成保证。']
    for row in diagnostics:
        if row['model'] != 'transfer' or row['protocol'] != 'daily_past10':
            continue
        if row['group'] in ('holiday', 'low_load_le_10') or (row['group'].startswith('Q') and (row['retained_coverage'] is None or row['retained_coverage'] < .905)):
            coverage = f"{row['retained_coverage']:.2%}" if row['retained_coverage'] is not None else '未定义'
            lines.append(f"- {row['building_id']} {row['group']}：n={row['n']}，通过n={row['retained_n']}，通过覆盖={coverage}，拒绝={row['rejection_rate']:.2%}，MAE={row['mae']:.3f}。")
    lines += ['', '## 解读与复现',
              '- 固定早期校准与每日反馈结果的差异揭示校准陈旧风险；每日反馈也不能保证用途/季节/假日的条件覆盖。',
              '- 低负荷时相对区间宽度门控易拒绝；高覆盖若伴随高拒绝或宽区间不代表可自动控制。突发跃迁、用途负荷差异及早期样本缺少季节/假日属于风险，具体证据见分组表；不能仅凭本评测断言因果。',
              '- 仅5栋、同Hog站同年、与源楼共享天气及日历；不能外推异站/异年，也不覆盖多步预测。源楼历史复用，不是全新的盲测数据集。',
              '- model_card 的单步 cross_building_coverage 填主评测按所有通过样本池化的覆盖率，完整分母、拒绝率与在线补充在结果里；多步字段不变。',
              '- 复现命令：`python -m scripts.evaluate_transfer_current`（已有 results.json 时拒绝覆写）。计划、输入、模型、脚本SHA256及依赖版本见 results.json，逐月日志见 run.log，逐小时预测见 predictions.csv.gz。',
              '- 验证命令与结果见 verification.log。']
    (ROOT/'report.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')

def model_card_transfer_fields(version, result_path=ROOT/'results.json'):
    """Only expose current-version, strict-primary evidence; never old Robin results."""
    result_path = Path(result_path)
    if not result_path.exists():
        return {}
    result = json.loads(result_path.read_text(encoding='utf-8'))
    if result['status'] != 'completed' or result['source_version'] != version:
        return {}
    if result['primary_protocol'] != 'early_only' or not result['early_only_no_test_labels']:
        raise ValueError('model-card primary must be strict early-only')
    plan_path = result_path.parent/'plan.json'
    if sha(plan_path) != result['provenance']['plan_sha256']:
        raise ValueError('transfer plan integrity mismatch')
    pred_path = result_path.parent/'predictions.csv.gz'
    if sha(pred_path) != result['predictions_sha256']:
        raise ValueError('transfer predictions integrity mismatch')
    m = result['pooled']['early_only']['transfer']
    return dict(cross_building_coverage=m['retained_coverage'],
                cross_building_context='Current Byron one-step monthly experts; Hog2017 five metadata-selected uses; Feb15-Dec31; early-only Feb5-14 CQR/risk calibration, frozen during test. Pooled final gate-passed coverage, NOT adaptive daily10 or old Robin; limited-history self-training comparator; no conditional/generalization guarantee.',
                cross_building_evaluation=dict(source_version=version, primary_protocol='early_only',
                    receipt=result_path.as_posix(), receipt_sha256=sha(result_path),
                    plan_sha256=result['provenance']['plan_sha256'],
                    buildings=result['selected_buildings'], test_start=result['test_start'],
                    test_end_exclusive=result['test_end_exclusive'], metrics=m,
                    daily_past10_supplement=result['pooled']['daily_past10']['transfer']))


if __name__ == '__main__':
    run()
