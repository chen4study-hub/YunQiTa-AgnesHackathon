"""Owned HTTP server, ten fixed real SSE requests; no resident takeover, no secrets."""
import json,os,socket,subprocess,sys,time
from pathlib import Path
import httpx
from src.agent.provider import get_llm_status,read_key

QUESTIONS=['现在几点','天气怎么样','今天日期是多少','现在储能电量多少','为什么这样调度','执行回执是什么','未来24小时峰值什么时候','明天最高负荷','空调改26度电费多少','为什么转人工']


def main(questions=QUESTIONS,prefix='chat_stream10_compact'):
    assert prefix in ('chat_stream10_compact','chat_stream10_compact_final','chat_compact_extra','chat_current_weather','chat_sentence_stream10','chat_sentence_stream10_final','chat_operator_updates')
    assert get_llm_status()['mode']=='real'
    data=json.loads(Path('exports/replay/normal.json').read_text(encoding='utf-8'));row=data['hours'][14]
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    child=subprocess.Popen([sys.executable,'-m','uvicorn','src.api.app:app','--host','127.0.0.1','--port',str(port),'--no-access-log'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    results=[]
    try:
        with httpx.Client(timeout=40,trust_env=False) as client:
            for _ in range(100):
                try:
                    if client.get(f'http://127.0.0.1:{port}/health').json()['llm']['mode']=='real':break
                except Exception:time.sleep(.1)
            else:raise RuntimeError('owned backend startup failed')
            for question in questions:
                start=time.perf_counter();first=None;first_answer=None;first_answer_source=None;events=[]
                with client.stream('POST',f'http://127.0.0.1:{port}/chat/stream',json={'scenario':'normal','origin':row['t'],'question':question,'display_date':'2026-10-12','display_time':'13:44'}) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if not line.startswith('data: '):continue
                        if first is None:first=round((time.perf_counter()-start)*1000,1)
                        event=json.loads(line[6:])
                        if first_answer is None and event.get('type')=='answer_delta' and event.get('text'):
                            first_answer=round((time.perf_counter()-start)*1000,1);first_answer_source=event.get('sentence_source')
                        events.append(event)
                done=next((e for e in reversed(events) if e['type']=='done'),{})
                answer=''.join(e['text'] for e in events if e['type']=='answer_delta')
                assert not any(x in answer for x in ['rule_full','rule_hold','rule_conservative','SOC'])
                progress=[e for e in events if e['type']=='progress']
                assertions={'no_supplement_prefix':'补充：' not in answer,'no_broken_next_day_scope':'不代表。' not in answer,
                    'progress_shape':all(e['id']=='chat-answer-wait' and e['text']==f"正在组织回答，已等待 {e['elapsed_seconds']} 秒" for e in progress)}
                if question=='空调改26度电费多少':assertions['savings_once']=answer.count('263.4 元')==1
                phases=done.get('phase_timings',[]);failed=[p['phase'] for p in phases if p['reason']!='call_succeeded']
                correction_steps=[e['text'] for e in events if e['type']=='step']
                result={'assertions':assertions,'progress_events':[e for e in events if e['type']=='progress'],'first_answer_source':first_answer_source,'first_answer_ms':first_answer,'correction_steps':correction_steps,'host_direct':not phases and 'get_time' in [e['tool'] for e in events if e['type']=='tool_start'],'question':question,'first_event_ms':first,'total_ms':round((time.perf_counter()-start)*1000,1),'explanation_source':done.get('explanation_source'),'known':done.get('known'),'grounded':done.get('grounded'),'llm_reason':done.get('llm_reason'),'fallback_phase':failed[-1] if failed else 'validation_or_scope' if done.get('explanation_source')!='llm' else None,'phase_timings':phases,'tool_names':[e['tool'] for e in events if e['type']=='tool_start'],'answer':answer}
                key,_=read_key();assert not key or key not in json.dumps(result)
                if result['host_direct']:result['fallback_phase']=None
                results.append(result)
                # Save each completed request, never retry for better outcomes.
                Path(f'experiments/{prefix}_results.json').write_text(json.dumps({'status':'running','results':results},ensure_ascii=False,indent=2),encoding='utf-8')
    finally:
        child.terminate();child.wait(timeout=10)
    if prefix=='chat_operator_updates':assert all(all(r['assertions'].values()) for r in results)
    llm=sum(r['explanation_source']=='llm' for r in results)
    result={'status':'completed','endpoint':'owned loopback instance of actual HTTP app, not production resident','resident_unchanged':True,'questions_frozen':questions,'llm_answers':llm,'llm_pct':100*llm/len(questions),'host_direct_answers':sum(r['host_direct'] for r in results),'failed_fallback_answers':sum(r['explanation_source']!='llm' and not r['host_direct'] for r in results),'all_first_events_under1s':all(r['first_event_ms']<1000 for r in results),'all_first_answers_under5s':all(r['first_answer_ms'] is not None and r['first_answer_ms']<5000 for r in results),'results':results}
    Path(f'experiments/{prefix}_results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# 真实HTTP流式10问','', '独立启动当前后端真实HTTP实例，未接管8000常驻；试验结束关闭自有进程。每个问题一次，不因失败重问。phase耗时含传输/退避，transport_attempts逐条为单次物理接口耗时；不含key/headers/URL/失败正文。','', '|问题|首事件ms|首回答字ms|总时长ms|措辞来源|回退阶段|select ms|answer ms|单次物理调用ms|','|---|---:|---:|---:|---|---|---|---|---|' ]
    for r in results:
        phase=lambda n:','.join(str(p['elapsed_ms']) for p in r['phase_timings'] if p['phase']==n)
        calls=[a['elapsed_ms'] for p in r['phase_timings'] for a in p['transport_attempts']]
        lines.append(f"|{r['question']}|{r['first_event_ms']}|{r['first_answer_ms']}|{r['total_ms']}|{'host_direct' if r['host_direct'] else r['explanation_source']}|{r['fallback_phase']}|{phase('select')}|{(phase('answer_stream') or phase('answer'))}|{calls}|")
    lines+=['',f"LLM完成{llm}/{len(questions)}；宿主直接回答{result['host_direct_answers']}条（非服务失败回退）；首事件均<1秒：{result['all_first_events_under1s']}。", '用户此前12问/6问失败为观察记录，非本试验同问题配对，不假称有此前端到端精确耗时。仅此次物理调用耗时不能证明服务长期变慢，需同请求跨时段基准。', '后端需要重启加载本轮代码。本轮没有重启生产常驻服务。']
    Path(f'experiments/{prefix}_report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8');print(json.dumps({'llm_answers':llm,'all_first_events_under1s':result['all_first_events_under1s']}))


if __name__=='__main__':main()
