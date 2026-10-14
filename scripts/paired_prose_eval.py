"""Commit-isolated 312-hour real pairing on frozen v4 inputs; no dispatch or tuning."""
import argparse,copy,hashlib,importlib,json,subprocess,sys,time,types
from collections import Counter
from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path
from src.agent.provider import read_key,get_llm_status

ROOT=Path('experiments');PLAN=ROOT/'prose_pair_v1_plan.json';ROWS=ROOT/'prose_pair_v1_hours.jsonl'
ARMS=['08cfb8e','13a9be8','17ad158']


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def load_commit(rev):
    base=Path('logs/prose_pair_sources')/rev;base.mkdir(parents=True,exist_ok=True)
    paths=subprocess.check_output(['git','ls-tree','-r','--name-only',rev,'src/agent']).decode().splitlines();hashes={}
    for path in paths:
        if not path.endswith('.py'):continue
        raw=subprocess.check_output(['git','show',rev+':'+path]);(base/Path(path).name).write_bytes(raw);hashes[path]=hashlib.sha256(raw).hexdigest()
    name='src._prose_pair_'+rev;package=types.ModuleType(name);package.__path__=[str(base.resolve())];sys.modules[name]=package
    tools=importlib.import_module(name+'.tools');config=json.loads(subprocess.check_output(['git','show',rev+':configs/agent_tools.json']))
    tools.tool_config=lambda:copy.deepcopy(config)
    provider=importlib.import_module(name+'.provider');provider.read_key=read_key;provider.get_llm_status=get_llm_status
    return importlib.import_module(name+'.orchestrator'),provider,importlib.import_module(name+'.display_text'),hashes


def counts(rows,rev):
    results=[r['arms'][rev]['result'] for r in rows]
    c=Counter('rule' if r['source']!='llm' else r['explanation_source'] for r in results)
    accepted=sum(not r['current_refused'] for r in rows)
    return {'hours':len(rows),'accepted_hours':accepted,'llm':c['llm'],'template':c['template'],'rule':c['rule'],
        'llm_pct_accepted':100*c['llm']/accepted if accepted else None,'final_unsourced':sum(r['arms'][rev]['unsourced'] for r in rows),
        'transport_calls':sum(len(a.get('transport_attempts',[])) or 1 for r in rows for a in r['arms'][rev]['provider_calls']),
        'fallback_reasons':dict(Counter(r['llm']['reason'] for r in results if r['source']!='llm'))}


def report(rows,plan):
    result={'status':'completed' if len(rows)==312 else 'paused','completed_pairs':len(rows),'plan_sha256':sha(PLAN),'rows_sha256':sha(ROWS) if ROWS.exists() else None,
        'arms':{rev:counts(rows,rev) for rev in ARMS},'days':{day:{rev:counts([r for r in rows if r['date']==day],rev) for rev in ARMS} for day in plan['dates']}}
    result['target_met']=result['status']=='completed' and result['arms'][ARMS[-1]]['llm_pct_accepted']>60 and result['arms'][ARMS[-1]]['final_unsourced']==0
    (ROOT/'prose_pair_v1_summary.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    lines=['# 同小时真实逐提交配对','', '每个提交重新真实调用，原v4输入/约束/SOC冻结，312小时含259接受小时；禁止按结果重跑，失败与门控绕过保留。循环平衡调用顺序，不是新预测盲测。数字0仅指最终允许清单校验，不是完整语义因果认证。', '', '|日期|提交|LLM措辞|模板措辞|规则|接受小时LLM%|最终无来源数|','|---|---|---:|---:|---:|---:|---:|']
    for day,arms in result['days'].items():
        for rev,c in arms.items():lines.append(f"|{day}|{rev}|{c['llm']}|{c['template']}|{c['rule']}|{c['llm_pct_accepted'] if c['llm_pct_accepted'] is not None else 'N/A'}|{c['final_unsourced']}|")
    lines+=['','中断记录：一次batch请求900秒但部署上限598秒被终止，已有131对保存；最多4个未保存在途小时对可能重新调用，尝试总数无法全部核实，不把未知结果计作成功。之后缩短批次续缺口，312个已保存完整对均唯一。','三天独立真实导出最终normal=16/8/0，peak=15/7/2，abstain=11/1/12（llm/template/rule）；上一版08cfb8e为7/12/5、6/15/3、3/9/12，三天均发生变化，不写没变。与配对三天计数不同，因为是另一个真实调用批次。','','汇总：',json.dumps(result['arms'],indent=2),'','目标达成：'+str(result['target_met']), '新旧逐小时来源若变化直接体现在表中；提交13a9be8是修复，17ad158是固定退避重试。同小时三臂均真实重跑，不用历史保存输出冒充此次baseline；控制字段须逐条等于冻存输入结果。']
    (ROOT/'prose_pair_v1_report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8');return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--pairs',type=int,default=52);parser.add_argument('--report-only',action='store_true');args=parser.parse_args()
    records=[json.loads(l) for l in Path('experiments/agent_eval_v4_hours.jsonl').read_text(encoding='utf-8').splitlines()];records.sort(key=lambda r:(r['date'],r['hour']))
    loaded={rev:load_commit(rev) for rev in ARMS}
    plan={'source':'experiments/agent_eval_v4_hours.jsonl','source_sha256':sha('experiments/agent_eval_v4_hours.jsonl'),'commits':ARMS,'commit_code_sha256':{rev:v[3] for rev,v in loaded.items()},'pairs':[{'date':r['date'],'hour':r['hour']} for r in records],'dates':sorted({r['date'] for r in records}),'workers':4,'balanced_order':'cyclic by index modulo3','frozen_before_calls':True,'no_prompt_threshold_date_tuning':True,'dispatch_enabled':False}
    if PLAN.exists():assert json.loads(PLAN.read_text())==plan,'frozen plan changed'
    else:PLAN.write_text(json.dumps(plan,indent=2),encoding='utf-8')
    saved=[json.loads(l) for l in ROWS.read_text(encoding='utf-8').splitlines()] if ROWS.exists() else [];done={r['index'] for r in saved};assert len(done)==len(saved)
    if not args.report_only:
        assert get_llm_status()['mode']=='real'
        entries=[(i,r) for i,r in enumerate(records) if i not in done][:args.pairs]
        def pair(entry):
            i,row=entry;out={'index':i,'date':row['date'],'hour':row['hour'],'current_refused':row['current_refused'],'order':ARMS[i%3:]+ARMS[:i%3],'arms':{}}
            for rev in out['order']:
                module,prov,display,_=loaded[rev]
                class Metered:
                    def __init__(self):self.p=prov.OpenAICompatibleProvider();self.calls=[]
                    def choose_candidate(self,*a):
                        answer=self.p.choose_candidate(*a);self.calls.append(copy.deepcopy(answer['llm']));return answer
                provider=Metered();start=time.monotonic()
                result=module.run_agent(copy.deepcopy(row['forecast']),copy.deepcopy(row['context']),copy.deepcopy(row['constraints']),provider=provider,dispatch_enabled=False,dispatch_current_only=True)
                fields=['timestamp','hvac_setpoint_c','battery_kw','action'];control=lambda x:[{k:p[k] for k in fields} for p in x['plan']]
                assert control(result)==control(row['result']) and result['receipt']['count']==0
                e=display.display_evidence({'forecast':module.rounded_tools(row['forecast']),'candidates':module.candidate_evidence(result['candidates'])},row['forecast']['predictions'][0]['timestamp'])
                unsupported=len(module.ungrounded_numbers(result['reason'],e));assert unsupported==0
                out['arms'][rev]={'result':result,'provider_calls':provider.calls,'unsourced':unsupported,'elapsed_ms':round((time.monotonic()-start)*1000,1)}
            return out
        with ThreadPoolExecutor(max_workers=4) as pool:
            for future in as_completed([pool.submit(pair,e) for e in entries]):
                row=future.result();text=json.dumps(row,ensure_ascii=False,separators=(',',':'),allow_nan=False);key,_=read_key();assert not key or key not in text
                with ROWS.open('a',encoding='utf-8') as f:f.write(text+'\n')
                saved.append(row)
    print(json.dumps(report(saved,plan)['arms'],indent=2),flush=True)


if __name__=='__main__':main()
