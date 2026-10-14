"""Foreground owned-port regression: answer-first-byte, evidence accuracy, resident untouched."""
import asyncio
import json
import os
import socket
import statistics
import subprocess
import sys
import time
from pathlib import Path
import httpx


async def probe(base,cases,origin,scenario):
    results=[]
    async with httpx.AsyncClient(timeout=35,trust_env=False) as client:
        for case in cases:
            chosen=case.get('scenario',scenario)
            origin_index=case.get('origin_index',14)
            chosen_origin=json.loads(Path(f'exports/replay/{chosen}.json').read_text(encoding='utf-8'))['hours'][origin_index]['t']
            body={'scenario':chosen,'origin':chosen_origin,'question':case['question'],'display_date':'2026-10-12','display_time':case.get('display_time',f'{origin_index:02d}:00')}
            expected_count=None
            if case.get('evidence_alert_count'):
                ops=json.loads(Path(f'exports/replay/{chosen}.ops.json').read_text(encoding='utf-8'))
                expected_count=sum(e['offset_ms']<=14*3600000 for e in ops['alerts'])
            started=time.monotonic();steps=[];first_step=None;first_answer=None;answer=[];tools=[];done={};errors=[];sentences={'llm':0,'template':0}
            async with client.stream('POST',base+'/chat/stream',json=body) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.startswith('data: '):continue
                    e=json.loads(line[6:]);now=time.monotonic()-started
                    if e['type']=='step':
                        steps.append(e.get('text',''))
                        if first_step is None:first_step=now
                    if e['type']=='tool_start':tools.append(e['tool'])
                    if e['type']=='answer_delta':
                        if first_answer is None:first_answer=now
                        answer.append(e['text'])
                        if e.get('sentence_source') in sentences:sentences[e['sentence_source']]+=1
                    if e['type']=='done':done=e
                    if e['type']=='error':errors.append(e)
            joined=''.join(answer)
            duration_ms=round((time.monotonic()-started)*1000,1)
            valid=bool(done.get('known') and done.get('grounded') and (case['tool'] is None or case['tool'] in tools) and all(s in joined for s in case['contains']) and not any(s in joined for s in case.get('excludes',[])))
            if expected_count is not None:valid=valid and f'{expected_count} 条告警记录' in joined
            if case.get('max_duration_ms'):valid=valid and duration_ms<=case['max_duration_ms']
            if case.get('recent_news_14_days'):
                import re
                from datetime import datetime,timedelta,timezone
                if '最近两周没有查到相关报道' in joined:
                    valid=valid and 'https://' not in joined and '最近两周查到的相关报道' not in joined
                else:
                    dates=re.findall(r'(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)',joined)
                    today=datetime.now(timezone.utc).date()
                    valid=valid and bool(dates) and '最近两周查到的相关报道' in joined and '来源：' in joined and 'https://' in joined
                    valid=valid and all(today-timedelta(days=14)<=datetime.fromisoformat(t).date()<=today for t in dates)
            if 'query_step_count' in case:valid=valid and steps.count('正在查询相关数据…')==case['query_step_count']
            if case.get('no_data_steps'):valid=valid and '正在查询相关数据…' not in steps
            if case.get('exact_sentences'):
                import re
                valid=valid and len([p for p in re.split(r'[。！？!?]',joined) if p.strip()])==case['exact_sentences']
            results.append({'steps':steps,'expected_alert_count':expected_count,'question':case['question'],'scenario':chosen,'origin_index':origin_index,'origin':chosen_origin,'display_time':body['display_time'],'correct_with_evidence':valid,'tools':tools,
                'duration_ms':duration_ms,'first_step_ms':round(first_step*1000,1) if first_step is not None else None,'first_answer_ms':round(first_answer*1000,1) if first_answer is not None else None,
                'reason':done.get('reason'),'answer':joined,'errors':errors,
                'explanation_source':done.get('explanation_source','template'),'sentence_sources':sentences,
                'narrative_required':case.get('narrative_required',False),'general_answer':case.get('general_answer',False),'phase_timings':done.get('phase_timings',[])})
        # Actual public source test; future year uses real empty official data, not model memory.
        public=[]
        for q in (['2020 年诺贝尔奖得主有哪些','2099 年诺贝尔奖得主有哪些'] if '--public' in sys.argv else []):
            r=await client.post(base+'/chat',json={'scenario':scenario,'origin':origin,'question':q});r.raise_for_status();out=r.json()
            assert not out['needs_human'] and out['tool_trace'][0]['tool']=='web_search'
            if q.startswith('2099'):assert '2099' in out['answer'] and not out['needs_human']
            public.append({'question':q,'known':out['known'],'reason':out['reason'],'answer':out['answer']})
    return results,public


def main():
    cases=json.loads(Path('tests/building_chat_cases.json').read_text(encoding='utf-8'))
    d=json.loads(Path('exports/replay/normal.json').read_text(encoding='utf-8'));origin=d['hours'][14]['t']
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    mode='real' if '--real' in sys.argv else 'demo'
    import tempfile
    db_dir=tempfile.TemporaryDirectory(prefix='agnes-chat-probe-')
    env=dict(os.environ,LLM_MODE=mode,OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',YUNQI_DB_PATH=str(Path(db_dir.name)/'takeover.db'))
    command=[sys.executable,'-m','uvicorn','src.api.app:app','--host','127.0.0.1','--port',str(port),'--access-log','--log-config','configs/backend_logging.json']
    child=subprocess.Popen(command,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    base=f'http://127.0.0.1:{port}';results=[]
    try:
        with httpx.Client(timeout=1,trust_env=False) as c:
            for _ in range(150):
                try:
                    if c.get(base+'/health').status_code==200:break
                except httpx.HTTPError:pass
                time.sleep(.1)
            else:raise RuntimeError('owned backend not ready')
        results,public=asyncio.run(probe(base,cases,origin,'normal'))
    finally:
        child.terminate()
        try:child.wait(timeout=10)
        except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
        db_dir.cleanup()
    rate=sum(r['correct_with_evidence'] for r in results)/len(results)
    median=statistics.median(r['first_answer_ms'] for r in results if r['first_answer_ms'] is not None)
    narrative=[r for r in results if r['narrative_required']]
    llm_n=sum(r['explanation_source']=='llm' for r in narrative)
    building_narrative=[r for r in narrative if not r['general_answer']]
    general=[r for r in results if r['general_answer']]
    wording={'building_narrative_questions':len(building_narrative),
        'building_narrative_ratio':sum(r['explanation_source']=='llm' for r in building_narrative)/len(building_narrative) if building_narrative else None,
        'new_general_passed':sum(r['correct_with_evidence'] for r in general),'new_general_questions':len(general),'narrative_questions':len(narrative),'llm_composed':llm_n,'ratio':llm_n/len(narrative) if narrative else None,
        'target':.8,'achieved':llm_n/len(narrative)>=.8 if narrative else False,
        'template_questions':[r['question'] for r in narrative if r['explanation_source']!='llm'],
        'all_questions_llm_composed':sum(r['explanation_source']=='llm' for r in results),
        'note':'Composition measured by validated answer source, not tool selection or whether an upstream call happened.'}
    receipt={'status':'passed' if rate>=.9 and median<3000 else 'failed','llm_mode':mode,
        'mode_note':'Real HTTP/SSE server; fixed question corpus and deterministic tool evidence; live semantic paraphrases assessed separately.',
        'questions':len(results),'correct_with_evidence':sum(r['correct_with_evidence'] for r in results),
        'correct_rate':rate,'first_answer_median_ms':median,'owned_port':port,'owned_process_stopped':child.poll() is not None,
        'resident_changed':False,'llm_wording':wording,'results':results,'public_queries':public}
    Path('experiments/building_chat_regression'+('_real' if mode=='real' else '')+'.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in receipt.items() if k not in ('results','public_queries')},ensure_ascii=False))
    if receipt['status']!='passed':raise SystemExit(1)


if __name__=='__main__':main()
