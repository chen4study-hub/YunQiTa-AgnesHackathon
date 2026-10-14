"""Same unrounded trace contract for both switches, isolated from reference text."""

def records_from_trace(trace, origin, success=True):
    from src.agent.display_text import display_evidence
    items=[t for t in trace if isinstance(t,dict) and isinstance(t.get('result'),dict)]
    records=[{'success':success,'trace':items,'data':items,
              'evidence':display_evidence(items,origin),'reference':''}] if items else []
    for t in items:
        if t['tool'] in ('web_search','city_weather'):
            records.append({'success':success,'trace':[t],'data':t['result'],'evidence':[],'reference':''})
    return records


def canonical_records(records,origin):
    out=[]
    for r in records:
        out.extend(records_from_trace(r.get('trace',[]),origin,r.get('success',False)))
    return out
