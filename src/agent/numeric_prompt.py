"""Numeric prompt evidence only; never grants new sources or weakens validation."""
import math

# Display units, not conversions. In particular confidence/SOC remain fractions.
MEANINGS={
    'point':'预测负荷(kW)','point_kw':'预测负荷(kW)','lower':'预测区间下界(kW)',
    'upper':'预测区间上界(kW)','prepared_upper_kw':'准备上界(kW)',
    'confidence':'置信度(比例)','risk_score':'风险评分','risk_threshold':'风险阈值',
    'hvac_setpoint_c':'空调设定(°C)','before_setpoint_c':'改前设定(°C)','after_setpoint_c':'改后设定(°C)',
    'battery_kw':'储能功率(kW，正放负充)','soc':'SOC(比例)','storage_soc':'SOC(比例)','soc_percent':'SOC(%)',
    'estimated_cost':'费用(元)','energy_cost_cny':'电费(元)','cost':'该小时电费(元)',
    'before_cost':'接受时段改前电费(元)','after_cost':'接受时段改后电费(元)',
    'before_peak_kw':'计入时段改前电网峰值(kW)','after_peak_kw':'计入时段改后电网峰值(kW)',
    'peak_increase_kw':'计入时段电网峰值增加量(kW)','peak_reduction_kw':'计入时段电网峰值降低量(kW)',
    'extra_cost_cny':'计入时段预计多花电费(元)','savings_cny':'接受时段改前减改后电费(元)','estimated_savings':'相对基准费用差(元)',
    'additional_cost_cny':'相对最低电费候选多付费用(元)',
    'upper_grid_peak_kw':'区间上界电网峰值(kW)','point_grid_peak_kw':'点预测电网峰值(kW)',
    'baseline_upper_grid_peak_kw':'基准上界峰值(kW)','upper_peak_reduction_kw':'相对基准上界削峰(kW)',
    'upper_peak_reduction_vs_cheapest_kw':'相对最低电费候选上界削峰(kW)',
    'estimated_peak_kw':'电网峰值(kW)','estimated_energy_kwh':'电网电量(kWh)',
    'pv_kw':'光伏功率(kW)','load_kw':'负荷功率(kW)','grid_kw':'电网负荷功率(kW)',
    'load_kwh':'该小时累计用电量(kWh，非功率)','grid_kwh':'该小时累计电网电量(kWh，非功率)','baseline_cost':'该小时基准电费(元)',
    'estimated_indoor_temp_c':'室内温度(°C)','outdoor_temp_c':'室外气温(°C)','humidity_percent':'湿度(%，宿主取整)',
    'comfort_degree_hours':'舒适越界度时(°C·h)','accepted_hours':'接受小时数',
    'excluded_refused_hours':'排除拒绝小时数','excluded_hours':'排除小时数','total_hours':'预测小时数',
    'constraint_violations':'约束违规数','horizon_hours':'调度窗口小时数','prediction_hours':'预测小时数',
    'peak_kw':'预测峰值(kW)','hour':'起报当地小时','minute':'起报当地分钟',
    'year':'当地年份','month':'当地月份','day':'当地日','count':'回执指令条数','elapsed_ms':'回执耗时(ms)',
}
MARKER='\n<allowed_numeric_evidence>\n'


def allowed_numbers(evidence):
    """Group identical numeric leaves by meaning; retain paths, never parse strings."""
    grouped={}
    def walk(value,path,field=''):
        if isinstance(value,bool):return
        if isinstance(value,(int,float)) and math.isfinite(value):
            number=f'{value:.1f}';meaning=MEANINGS.get(field,field)
            grouped.setdefault((number,meaning),[]).append(path)
        elif isinstance(value,dict):
            for key,child in value.items():
                # Legacy 1h energy aliases coincide numerically with power but are
                # not prompt labels for load/peak prose when explicit power exists.
                if key in ('load_kwh','grid_kwh') and key.replace('_kwh','_kw') in value:continue
                walk(child,f'{path}.{key}' if path else key,key)
        elif isinstance(value,list):
            for i,child in enumerate(value):walk(child,f'{path}[{i}]',field)
    walk(evidence,'')
    return [dict(value=number,meaning=meaning,sources=paths) for (number,meaning),paths in grouped.items()]


def numeric_instruction(evidence):
    rows=allowed_numbers(evidence)
    lines=[f"{r['value']} | {r['meaning']} | {', '.join(r['sources'])}" for r in rows]
    return MARKER+'Only use the numeric VALUES below in prose, with their stated meanings/units. One decimal maximum. '+\
        'Do not recompute, subtract, round again, convert fractions to percentages, invent durations or use numbers from source paths, timestamps or model IDs. '+\
        'Structural IDs may only be copied into structured fields, not numerical claims. If no supported number is needed, use words.\n'+\
        '\n'.join(lines)+'\n</allowed_numeric_evidence>'
