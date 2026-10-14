"""Freeze selected cases and documented question-scope assertion corrections."""
import copy
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
HERE=Path(__file__).resolve().parent


def build():
    corpus=json.loads((ROOT/'tests/building_chat_cases.json').read_text(encoding='utf-8'))
    failures=json.loads((HERE/'v3_fix_summary.json').read_text(encoding='utf-8'))['failures']
    sample=[3,10,14,18,21,29,35,40,41,43,47,51,55,80,86]
    old=json.loads((HERE/'results/quality_full_on.json').read_text(encoding='utf-8'))['results']
    assert len(failures)==31 and len(sample)==15 and all(old[i]['correct_with_evidence'] for i in sample)
    changes=[]; cases=[]
    def change(c,i,contains,kind,reason,**fields):
        before={k:c.get(k) for k in ('contains','evidence_alert_count','recent_news_14_days') if k in c}
        c.update(contains=contains,semantic_check=kind,**fields)
        changes.append({'original_index':i,'question':c['question'],'old':before,
                        'new':{k:c[k] for k in ('contains','semantic_check',*fields)},'reason':reason})
    for i in failures+sample:
        c=copy.deepcopy(corpus[i]);c.update(original_index=i,semantic_evidence=True,cohort='failed31' if i in failures else 'passed15')
        if i in (0,1):
            change(c,i,['kWh'],'energy_kwh','只问累计电量，不必顺带电费；仍要求energy_totals、实际total_kwh值和kWh。')
        if i in (3,8):
            change(c,i,['元'],'energy_cost','只问指定日电费，不强制无关kWh；仍要求日期工具实查的total_cost_cny与元。')
        if i in (16,17,18):
            if i==18:
                # Work-order scope remains covered by the original wording and grounding.
                pass
            else:
                change(c,i,[],'alerts_count','零告警可写没有告警或0条告警，不强制记录二字；用实际count核对，非零不能说无。')
        if i==20:
            change(c,i,['层'],'lift_health','不强制载客二字，但要求实际运行楼层及明确无设备健康诊断，不能将停靠/运行记录说成健康结论。')
        if i in (21,22,23):
            field,unit=('load_pct','%') if i==22 else ('passengers','人') if i==23 else ('floor','层')
            change(c,i,[unit],'lift_field','只问载重/人数/所在楼层，不必附所有字段；仍逐个核对所查电梯ID和所问字段实际值。',expected_field=field,expected_unit=unit)
        if i in (24,25,26,27,29,30):
            field,unit={24:('occupancy_people','人'),25:('mean_temp_c','°C'),26:('floor_actual_kw','kW'),27:('co2_ppm','ppm'),29:('fan_pct','%'),30:('lighting_pct','%')}[i]
            change(c,i,[unit],'floor_field','单项楼层问不要求无关kW/温度/CO₂；仍核对具体楼层、所问字段的实际值及单位。',expected_field=field,expected_unit=unit)
        if i in (32,33):
            change(c,i,['kWh'],'storage_field','累计充/放电量不必带瞬时kW；不能用当前功率冒充累计，核对实查累计字段。',expected_field='charge_kwh' if i==32 else 'discharge_kwh',expected_label='充电' if i==32 else '放电')
        if i in (38,39):
            change(c,i,['%' if i==38 else 'μg/m³'],'building_field','室内湿度/PM2.5不必附总负荷和CO₂；保留building_state与environment所问字段实际值检查。',expected_field='relative_humidity_pct' if i==38 else 'pm25_ug_m3',expected_unit='%' if i==38 else 'μg/m³')
        if c.get('recent_news_14_days'):
            change(c,i,[],'news','放宽最近两周查到的相关报道固定开头；不放宽14天、真实已查URL、问题城市/天气相关性。无相关源必须直说没查到，不能用城市天气替代新闻。')
        cases.append(c)
    (HERE/'round2_cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2),encoding='utf-8')
    (HERE/'round2_assertion_changes.json').write_text(json.dumps(changes,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Frozen cases:',len(cases),'assertion changes:',len(changes),'sample:',sample)


if __name__=='__main__':build()
