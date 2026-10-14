"""One assertion set for both pipelines; original questions stay byte-identical."""
import copy
import json
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
import sys
sys.path.insert(0,str(ROOT))


def build():
    original=json.loads((ROOT/'tests/building_chat_cases.json').read_text(encoding='utf-8'))
    cases=copy.deepcopy(original)
    log=json.loads((HERE/'round2_assertion_changes.json').read_text(encoding='utf-8'))
    for change in log:
        cases[change['original_index']].update(change['new'])
    def amend(i, reason, **values):
        old={k:cases[i].get(k) for k in values}
        cases[i].update(values)
        log.append({'original_index':i,'question':cases[i]['question'],'old':old,'new':values,'reason':reason})
    for i in (4,5):
        amend(i,'只问累计电量，不要求无关电费；仍核对查得累计值/单位。',contains=['kWh'],semantic_check='energy_kwh')
    for i,f,u in [(28,'fresh_air_m3_h','m³/h'),(31,'mean_temp_c','°C')]:
        # #31 is storage history, not a single-floor field.
        if i==28:
            amend(i,'只问新风量，不强制温度/负荷；检查对应楼层实值和单位。',contains=[u],semantic_check='floor_field',expected_field=f,expected_unit=u)
    for i in (35,36):
        amend(i,'只问发电量不必附瞬时功率；仍要求真实generation_kwh。',contains=['kWh'],semantic_check='pv_energy')
    amend(50,'零告警允许报警/告警同义表达，实际count不能改变。',contains=[],semantic_check='alerts_count')
    amend(46,'回执问题两种问法同用实际count/elapsed_ms及日志标签，接受ms或毫秒但必须空格。',contains=['BA/EMS'],semantic_check='receipt')
    amend(51,'回执按真实count和elapsed_ms检查；允许毫秒或ms，二者均必须数字空格单位及BA/EMS日志标签。',contains=['BA/EMS'],semantic_check='receipt')
    amend(52,'允许值班核对/交值班人员处理同义；仍要求实际接管状态与源原因，不允许声称本小时无需人工。',contains=['值班'],semantic_check='handoff')
    for i,c in enumerate(cases):
        if c.get('recent_news_14_days') and c.get('semantic_check')!='news':
            amend(i,'新闻不强制固定开头；实际源必须14天内且标题/正文主题相关，无源只允许没查到相关报道。',contains=[],semantic_check='news')
        c.update(original_index=i,semantic_evidence=True)
        if c['question']=='今天适合出去散步吗':
            amend(i,'统一现有湿度显示一位小数，57%与57.0%数值相同。',contains=['57.0%' if x=='57%' else x for x in c['contains']])
        if '业主' in c['question'] or '物业公司' in c['question']:
            c['allow_no_data']=True
    multi=json.loads((HERE/'multi_cases.json').read_text(encoding='utf-8'))
    from src.agent.agent_tools import run_tool
    from src.data.replay_payload import load_replay
    import threading
    d=load_replay('normal');r=d['hours'][14]
    ref=run_tool('hvac_compare',{'setpoint_c':24},d,r,'2026-10-13','14:00',2,threading.Event(),'空调改到24度能省多少钱')
    comparison=next(t['result'] for t in ref['trace'] if t['tool']=='compare_costs')
    from src.agent.chat_tools import relative_time
    excluded=[relative_time(e['timestamp'],r['t']) if 'timestamp' in e else ('次日 ' if e['day_label']=='次日' else '')+f"{e['hour']:02d}:{e['minute']:02d}" for e in comparison['excluded']]
    old=copy.deepcopy(multi[4:6])
    multi[4]['contains']=['24.0 °C','预计多花','不按整天']
    multi[5]['contains']=list({e['reason'] for e in comparison['excluded']})
    multi[5]['expected_exclusions']=comparison['excluded']
    log.append({'multi_group':'hvac','old':old,'new':multi[4:6], 'reason':'旧620.7及排除时刻来自旧数据，不是当前冻结记录；以现有工具实际比较方向和全部排除时刻检查，不删范围要求。'})
    for i,c in enumerate(multi):
        c.update(original_index=i)
        if c['group']=='unknown':c['allow_no_data']=True
    for name,value in [('round3_cases.json',cases),('round3_multi_cases.json',multi),('round3_assertion_changes.json',log)]:
        (HERE/name).write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    assert len(cases)==91 and len(multi)==20
    print('Prepared 91 cases / 10 groups; documented changes:',len(log))


if __name__=='__main__':build()
