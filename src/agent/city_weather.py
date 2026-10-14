"""Key-free public city weather; fixed Open-Meteo endpoints, not tower evidence."""
import re
import math
from datetime import datetime,timedelta
import httpx

COUNTRIES={'伦敦':'GB','London':'GB'}

def weather_label(code):
    code=int(code)
    if code==0:return '晴'
    if code in (1,2,3):return {1:'晴间多云',2:'局部多云',3:'阴'}[code]
    if code in (45,48):return '雾'
    if code in (51,53,55,56,57):return '毛毛雨'
    if code in (61,63,65,66,67,80,81,82):return '雨'
    if code in (71,73,75,77,85,86):return '雪'
    if code in (95,96,99):return '雷雨'
    return '天气状况未提供'

# Conservative extraction: names are sent only as geocoding query text, not URLs.
def city_name(question):
    # Impact phrasing includes a subject before the city (e.g. 台风对上海天气).
    impact=re.search(r'(?:对|影响)([\u4e00-\u9fffA-Za-z]{2,20}?)(?:市)?(?:的)?(?:天气|气温|温度)',question)
    if impact:return impact[1]
    q=re.sub(r'^(?:请问|请|帮我|查询|搜索|联网|查一下|今天|明天|现在|当前|今日)+','',question.strip())
    m=re.match(r'([\u4e00-\u9fffA-Za-z\s]{2,30}?)(?:市|的)?(?:今天|明天|现在|当前|今日|次日|天气|气温|温度|台风)',q)
    city=m[1].strip() if m else None
    if city in ('本楼','本栋','云栖塔','室外','这里','未来几小时','未来','明天','今天','现在','当前'):return None
    return city


def lookup(question,client):
    from .web_search import get
    city=city_name(question)
    if not city:return {'status':'empty','sources':[]}
    params=dict(name='London' if city in COUNTRIES else city,language='zh',count=1)
    if city in COUNTRIES:params['countryCode']=COUNTRIES[city]
    geo=get(client,'https://geocoding-api.open-meteo.com/v1/search',params)
    found=geo.get('results',[])
    if not found:return {'status':'empty','sources':[]}
    g=found[0]
    if city in COUNTRIES and g.get('country_code')!=COUNTRIES[city]:raise ValueError('ambiguous city country')
    lat=float(g['latitude']);lon=float(g['longitude'])
    if not -90<=lat<=90 or not -180<=lon<=180:raise ValueError('invalid geocoding location')
    params=dict(latitude=lat,longitude=lon,current='temperature_2m,precipitation,weather_code',
                daily='temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',timezone='auto',forecast_days=2)
    endpoint='https://api.open-meteo.com/v1/forecast';d=get(client,endpoint,params)
    current=d['current'];daily=d['daily'];times=daily['time']
    tomorrow=(datetime.fromisoformat(current['time']).date()+timedelta(days=1)).isoformat()
    if tomorrow not in times:raise ValueError('missing next-day weather')
    i=times.index(tomorrow)
    numbers=[current['temperature_2m'],current['precipitation'],daily['temperature_2m_min'][i],daily['temperature_2m_max'][i],daily['precipitation_sum'][i]]
    if not all(math.isfinite(float(v)) for v in numbers):raise ValueError('nonfinite weather')
    place=g['name']+('（'+g['country']+'）' if g.get('country') else '');parts=[]
    parts.append(f"{place}当前气温 {float(current['temperature_2m']):.1f} °C，降水 {float(current['precipitation']):.1f} mm，{weather_label(current['weather_code'])}。")
    parts.append(f"次日最低 {float(daily['temperature_2m_min'][i]):.1f} °C、最高 {float(daily['temperature_2m_max'][i]):.1f} °C，降水 {float(daily['precipitation_sum'][i]):.1f} mm，{weather_label(daily['weather_code'][i])}。")
    url=str(httpx.URL(endpoint,params=params));answer=''.join(parts)
    return dict(status='ok',answer=answer,sources=[dict(title='Open-Meteo '+place+'天气',url=url,snippet=answer)],
                city_weather=dict(city=place,country=g.get('country'),latitude=lat,longitude=lon,current=current,daily=daily))


def query(question, seconds=8., cancel=None, client_factory=httpx.Client):
    """Bounded fixed Open-Meteo adapter, never generic keyword-routed search."""
    import time
    import queue
    import threading
    from .web_search import SLOTS
    if not city_name(question):return {'status':'empty','sources':[]}
    seconds=min(8.,max(.01,float(seconds)))
    if not SLOTS.acquire(blocking=False):return {'status':'unavailable','sources':[]}
    deadline=time.monotonic()+seconds;local=threading.Event();box=queue.Queue(1)
    def work():
        try:
            with client_factory(timeout=httpx.Timeout(seconds,connect=min(2.,seconds)),
                              follow_redirects=False,trust_env=False) as client:
                client._lookup_cancel=local;client._lookup_deadline=deadline
                box.put(lookup(question,client) if not local.is_set() else {'status':'unavailable','sources':[]})
        except Exception:box.put({'status':'unavailable','sources':[]})
        finally:SLOTS.release()
    threading.Thread(target=work,daemon=True,name='city-lookup').start()
    try:
        while time.monotonic()<deadline and not (cancel is not None and cancel.is_set()):
            try:return box.get(timeout=min(.05,max(.001,deadline-time.monotonic())))
            except queue.Empty:pass
        return {'status':'unavailable','sources':[]}
    finally:local.set()
