"""Carry the same questions forward; document semantic rather than synonym checks."""
import json,copy
from pathlib import Path
H=Path(__file__).resolve().parent

def build():
    full=json.loads((H/'round3_cases.json').read_text(encoding='utf-8'))
    multi=json.loads((H/'round3_multi_cases.json').read_text(encoding='utf-8'))
    changes=[]
    def amend(c,why,**kw):
        old={k:c.get(k) for k in kw};c.update(kw)
        changes.append({'question':c['question'],'index':c['original_index'],'old':old,'new':kw,'reason':why})
    for c in full:
        if c['tool']=='compare_costs':
            amend(c,'同义费用措辞不决定通过；改前改后温度/电费/方向/峰值/全部排除时段按工具原始值核对。',
                  contains=['元','kW'],semantic_check='hvac')
        if c['original_index']==53:amend(c,'用户明确要求两句，自动检查恰好两句。',exact_sentences=2)
        if c['original_index']==88:amend(c,'光伏瞬时pv_kw来自current_energy或pv_generation同字段均可；不能用累计kWh替代。',
                                       tool=None,semantic_check='pv_power')
    for c in multi:
        c['semantic_evidence']=True
        if c['tool']=='hvac_compare':
            amend(c,'同义措辞按原始比较值和方向，保留全部排除时刻及原因/非整天。',contains=['元','kW'],semantic_check='hvac')
        if c['group']=='unknown':
            amend(c,'明确查不到本楼业主物业记录可正确，不要求固定系统里没有。',contains=[],semantic_check='no_local_identity')
        if c['original_index']==11:
            amend(c,'月日中文与ISO日期等价，必须来自工具display_date而非历史起点年份。',contains=[],semantic_check='host_date')
    for name,obj in [('round4_cases.json',full),('round4_multi_cases.json',multi),('round4_assertion_changes.json',changes)]:
        (H/name).write_text(json.dumps(obj,ensure_ascii=False,indent=2),encoding='utf-8')
    assert len(full)==91 and len(multi)==20
    print('91 questions / 10 groups preserved;',len(changes),'semantic adaptations')

if __name__=='__main__':build()
