"""Parallel public search and bounded, DNS-pinned HTTPS result-page reads."""
import html
import json
import re
import threading
import queue
from datetime import date,datetime,timedelta,timezone
from urllib.parse import quote,urlsplit,parse_qs
import httpx

SLOTS=threading.BoundedSemaphore(4)
CATEGORY={'Chemistry':'化学奖','Economic Sciences':'经济学奖','Literature':'文学奖',
 'Peace':'和平奖','Physics':'物理学奖','Physiology or Medicine':'生理学或医学奖'}
CATEGORY_CODES={'Chemistry':'che','Economic Sciences':'eco','Literature':'lit','Peace':'pea','Physics':'phy','Physiology or Medicine':'med'}

def news_request(question):
    return bool(re.search(r'新闻|近期|最近|新近|最新',question)) and not nobel_request(question)


def utc_now():return datetime.now(timezone.utc)


def recent_publication(stamp):
    from email.utils import parsedate_to_datetime
    try:
        value=parsedate_to_datetime(stamp)
        if value.tzinfo is None:return None
        value=value.astimezone(timezone.utc);now=utc_now()
        return value if now-timedelta(days=14)<=value<=now else None
    except (ValueError,TypeError,OverflowError):return None


def news_result(result):
    # Host owns time scope and answer: no LLM wait or invented recent events.
    sources=result.get('sources',[])
    if sources:
        answer='最近两周查到的相关报道：'+''.join(s['published_at'][:10]+'，'+s['title']+'。' for s in sources)
    else:
        prefix='查询已到时限，' if result.get('status')=='deadline' else '新闻源暂不可用，' if result.get('status')=='unavailable' else ''
        answer=prefix+'最近两周没有查到相关报道。'
    return {**result,'answer':answer,'recent_news':True,'lookback_days':14}


def nobel_request(question):
    return bool(re.search(r'(?:诺贝尔|诺奖|(?:19|20)\d{2}\s*年.*(?:物理学奖|化学奖|生理学或医学奖|医学奖|经济学奖|文学奖|和平奖))',question))

ALLOWED={'api.nobelprize.org','zh.wikipedia.org','en.wikipedia.org','geocoding-api.open-meteo.com','api.open-meteo.com'}


def safe_url(url):
    p=urlsplit(url)
    return p.scheme=='https' and p.hostname in ALLOWED|{'www.nobelprize.org','nobelprize.org'} and not p.username and not p.password and not p.port


def get(client,url,params=None):
    cancel=getattr(client,'_lookup_cancel',None)
    if cancel is not None and cancel.is_set():raise TimeoutError('cancelled')
    if urlsplit(url).hostname not in ALLOWED or not safe_url(url):raise ValueError('unsafe source')
    with client.stream('GET',url,params=params) as r:
        raw=read_limited(r,client)
    return json.loads(raw)


def search_query(question):
    question=question.replace('诺奖','诺贝尔奖')
    q=re.sub(r'给出来源链接|请附来源|来源链接|链接|来源|有哪些|有什么|怎么样|如何|今天|明天|当前|现在|最新|新闻|近期|最近|联网|查询|搜索|查一下|请|帮我|(?:\d+|[一二三四五六七八九十]+)\s*(?:个|条|项)',' ',question)
    q=re.sub(r'[？?，,。！!；;]', ' ',q)
    from .city_weather import city_name
    city=city_name(question)
    if city and not re.search('台风|影响',question) and any(w in question for w in ('天气','气温')):return city+' 天气'
    return re.sub(r'\s+',' ',q).strip()[:500]


def bing_sources(question,client,news=False,recent=False):
    from xml.etree import ElementTree
    query=search_query(question)
    endpoint='https://www.bing.com/news/search' if news else 'https://www.bing.com/search'
    with client.stream('GET',endpoint,params={'q':query,'format':'rss','setlang':'zh-CN'}) as r:
        raw=read_limited(r,client)
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():raise ValueError('unsafe XML')
    sources=[]
    for item in ElementTree.fromstring(raw).findall('./channel/item')[:15]:
        title=html.unescape(item.findtext('title','公开资料'));snippet=html.unescape(re.sub('<[^>]*>','',item.findtext('description','')))[:600]
        if not relevance_score(question,{'title':title,'snippet':snippet}):continue
        url=html.unescape(item.findtext('link',''));p=urlsplit(url)
        # Bing news wraps publisher HTTPS links in an HTTP apiclick URL.
        # Decode the URL parameter locally; never visit the wrapper or result.
        if p.hostname=='www.bing.com' and p.path=='/news/apiclick.aspx':
            url=parse_qs(p.query).get('url',[''])[0];p=urlsplit(url)
        if p.scheme!='https' or not p.hostname or p.username or p.password:continue
        stamp=item.findtext('pubDate','')
        published=recent_publication(stamp) if news or recent else None
        if (news or recent) and published is None:continue
        source={'title':title,'url':url,'snippet':('发布时间：'+stamp+'。' if stamp else '')+snippet}
        if published is not None:source['published_at']=published.isoformat()
        sources.append(source)
    if news or recent:
        from email.utils import parsedate_to_datetime
        def publication(item):
            try:return parsedate_to_datetime(item['snippet'].split('发布时间：',1)[1].split('。',1)[0]).timestamp()
            except Exception:return 0.
        sources.sort(key=publication,reverse=True)
    sources=list({s['url']:s for s in sources}.values())[:5]
    return sources


def wikipedia_sources(question,client):
    d=get(client,'https://zh.wikipedia.org/w/api.php',{'action':'query','list':'search','srsearch':search_query(question),'srlimit':3,'format':'json'})
    return [{'title':r['title'],'url':'https://zh.wikipedia.org/wiki/'+quote(r['title'].replace(' ','_'),safe=''),
             'snippet':html.unescape(re.sub('<[^>]*>','',r['snippet']))[:600]} for r in d.get('query',{}).get('search',[])]


def lookup(question,client):
    year=re.search(r'(?<!\d)(20\d{2}|19\d{2})(?!\d)',question)
    if nobel_request(question) and year:
        y=int(year[0]);d=get(client,'https://api.nobelprize.org/2.1/nobelPrizes',{'nobelPrizeYear':y,'limit':10})
        prizes=[p for p in d.get('nobelPrizes',[]) if p.get('awardYear')==str(y) and p.get('dateAwarded','9999')<=date.today().isoformat()]
        if not prizes:return {'status':'empty','sources':[],'answer':None}
        wanted=next((en for en,zh in CATEGORY.items() if zh in question),None)
        if wanted is None and '医学奖' in question:wanted='Physiology or Medicine'
        if wanted:prizes=[p for p in prizes if p.get('category',{}).get('en')==wanted]
        parts=[];sources=[]
        for p in prizes:
            laureates=p.get('laureates',[])
            if not laureates:continue
            names=[(a.get('knownName') or a.get('orgName') or a.get('fullName') or {}).get('en') for a in laureates]
            if not all(names):continue
            category=p.get('category',{}).get('en')
            if category not in CATEGORY:continue
            cat=CATEGORY[category]
            parts.append(cat+'：'+'、'.join(names)+'。')
            expected=f'https://api.nobelprize.org/2/nobelPrize/{CATEGORY_CODES[category]}/{y}'
            entry=next((link['href'] for link in p.get('links',[]) if link.get('rel')=='nobelPrize' and link.get('href')==expected),None)
            url=entry or str(httpx.URL('https://api.nobelprize.org/2.1/nobelPrizes',params={'nobelPrizeYear':y,'nobelPrizeCategory':CATEGORY_CODES[category],'limit':10}))
            title=f'{y} 年{cat}' if entry else '诺贝尔奖官方查询资料'
            sources.append({'title':title,'url':url,'snippet':f'{y} 年诺贝尔奖 '+parts[-1]})
        return {'status':'ok' if parts else 'empty','sources':sources,'answer':f'{y} 年已公布的获奖名单：'+''.join(parts) if parts else None}
    sources=bing_sources(question,client,news=news_request(question))
    return {'status':'ok' if sources else 'empty','sources':sources,'answer':None}


from html.parser import HTMLParser
import time
import socket
import ipaddress


class SearchHTML(HTMLParser):
    """Parse DDG's static HTML results without executing page content."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results=[]
        self.current=None
        self.field=None
        self.depth=0

    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs); classes=attrs.get('class','').split()
        if tag=='a' and 'result__a' in classes:
            url=attrs.get('href','')
            if url.startswith('//'):url='https:'+url
            parsed=urlsplit(url)
            if parsed.hostname in ('duckduckgo.com','html.duckduckgo.com'):
                url=parse_qs(parsed.query).get('uddg',[''])[0]
            self.current={'title':'','url':url,'snippet':''}
            self.results.append(self.current)
            self.field='title';self.depth=1
        elif self.current is not None and 'result__snippet' in classes:
            self.field='snippet';self.depth=1
        elif self.field and tag not in ('br','img','meta','input','hr'):
            self.depth+=1

    def handle_endtag(self, tag):
        if self.field:
            self.depth-=1
            if self.depth<=0:self.field=None

    def handle_data(self, data):
        if self.field and self.current is not None:
            self.current[self.field]+=data


def read_limited(response, client, limit=512000):
    response.raise_for_status()
    if int(response.headers.get('content-length','0'))>limit:
        raise ValueError('source too large')
    parts=[];size=0
    for chunk in response.iter_bytes():
        if (getattr(client,'_lookup_cancel',None) is not None and client._lookup_cancel.is_set()
                or time.monotonic()>=getattr(client,'_lookup_deadline',float('inf'))):
            raise TimeoutError('lookup deadline')
        size+=len(chunk)
        if size>limit:raise ValueError('source too large')
        parts.append(chunk)
    return b''.join(parts)


def public_url(url):
    """Syntax/literal screening; hostname DNS must additionally be pinned before GET."""
    try:
        p=urlsplit(url)
        if (p.scheme!='https' or not p.hostname or p.username or p.password
                or p.port not in (None,443) or any(ord(c)<33 for c in url)
                or '\\' in url):return False
        host=p.hostname.rstrip('.').lower()
        if host in ('localhost','localhost.localdomain') or host.endswith(('.localhost','.local','.internal','.lan')):
            return False
        try:return global_address(host)
        except ValueError:return '.' in host
    except (TypeError,ValueError):return False


def duckduckgo_sources(question, client):
    with client.stream('GET','https://html.duckduckgo.com/html/',
                       params={'q':search_query(question)}) as response:
        raw=read_limited(response,client)
    parser=SearchHTML();parser.feed(raw.decode('utf-8','replace'))
    return [{**r,'title':re.sub(r'\s+',' ',r['title']).strip()[:300],
             'snippet':re.sub(r'\s+',' ',r['snippet']).strip()[:600]}
            for r in parser.results[:15] if r['title'].strip() and public_url(r['url'])]


def relevance_score(question, source):
    query=search_query(question).lower()
    query=re.sub(r'得主是谁|得主|是谁|是什么|有哪些|哪些|的|请问|获奖者',' ',query)
    chunks=re.findall(r'[a-z]{2,}|[\u4e00-\u9fff]{2,}',query)
    terms=list(dict.fromkeys(part for t in chunks for part in
               ([t] if t.isascii() or len(t)<=3 else [t[i:i+2] for i in range(len(t)-1)])))
    if not terms:return 0.
    title=source.get('title','').lower()
    title=title.replace('诺奖','诺贝尔奖')
    hay=(title+' '+source.get('snippet','')+' '+source.get('body','')[:1000]).lower().replace('诺奖','诺贝尔奖')
    matched=sum(t in hay for t in terms)
    if matched<max(1,(len(terms)+1)//2):return 0.
    # Numbers alone do not establish topic; an explicit requested year must match.
    years=re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)',query)
    if years and not all(y in hay for y in years):return 0.
    return matched/len(terms)+sum(t in title for t in terms)/len(terms)


def merge_sources(question, results):
    kept={}
    weights={'duckduckgo':.15,'bing':.05,'wikipedia':0.,'nobel':.2}
    for engine, result in results:
        for source in result.get('sources',[]):
            if not public_url(source.get('url','')):continue
            score=relevance_score(question,source)
            if not score:continue
            candidate={**source,'engine':engine,'relevance':round(score+weights[engine],4)}
            url=candidate['url'].split('#',1)[0]
            candidate['url']=url
            if url not in kept or candidate['relevance']>kept[url]['relevance']:
                kept[url]=candidate
    return sorted(kept.values(),key=lambda s:(-s['relevance'],s['url']))[:5]

def global_address(value):
    address=ipaddress.ip_address(value)
    return (address.is_global and not address.is_multicast and not address.is_reserved
            and value!='168.63.129.16'
            and (not isinstance(address,ipaddress.IPv6Address) or
                 not address.sixtofour and not address.teredo))


def resolve_public(host):
    """Reject mixed public/private DNS answers, then connect to a validated IP."""
    addresses=list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(
        host,443,type=socket.SOCK_STREAM)))
    if not addresses or not all(global_address(a) for a in addresses):
        raise ValueError('nonpublic address')
    return addresses[0]


class PageText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts=[];self.hidden=0

    def handle_starttag(self, tag, attrs):
        if tag in ('script','style','noscript','template','svg'):self.hidden+=1
        elif not self.hidden and tag in ('p','div','h1','h2','h3','li','br'):self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('script','style','noscript','template','svg') and self.hidden:self.hidden-=1

    def handle_data(self, data):
        if not self.hidden:self.parts.append(data)


def fetch_page(url, client, seconds=2.):
    """Only search-result HTTPS URLs; no redirects/proxy, DNS pinned with TLS SNI.

    Actual httpx clients are created with trust_env=False by search. A public
    hostname is resolved once, every returned address checked; TCP uses that
    numeric address while Host and certificate verification retain the hostname.
    A later DNS rebind therefore cannot route this GET to an internal machine.
    """
    if not public_url(url):raise ValueError('unsafe page URL')
    cancel=getattr(client,'_lookup_cancel',None)
    if cancel is not None and cancel.is_set():raise TimeoutError('lookup cancelled')
    parsed=httpx.URL(url)
    address=resolve_public(parsed.host)
    pinned=parsed.copy_with(host=address)
    left=min(2.,seconds,getattr(client,'_lookup_deadline',float('inf'))-time.monotonic())
    if left<=0 or cancel is not None and cancel.is_set():raise TimeoutError('page deadline')
    with client.stream('GET',pinned,headers={'Host':parsed.host,'Accept':'text/html,text/plain'},
                       extensions={'sni_hostname':parsed.host},follow_redirects=False,
                       timeout=httpx.Timeout(left,connect=min(1.,left))) as response:
        kind=response.headers.get('content-type','').split(';',1)[0].lower()
        if kind not in ('text/html','application/xhtml+xml','text/plain'):
            raise ValueError('unsupported page type')
        raw=read_limited(response,client,256000)
        text=raw.decode(response.encoding or 'utf-8','replace')
    if kind=='text/plain':return re.sub(r'\s+',' ',text).strip()[:10000]
    parser=PageText();parser.feed(text)
    return re.sub(r'[ \t\r\f\v]+',' ',''.join(parser.parts)).strip()[:10000]

def search(question, seconds=8., client_factory=httpx.Client, cancel=None):
    """DDG primary, Bing/wiki backups in parallel; optional Nobel enhancement.

    No topic is required to enter this tool. Ranking merges completed engines;
    allow a short backup grace when DDG has useful results. At most two top
    pages share the same whole-operation deadline; failures keep snippets.
    No raw exceptions or HTTP headers are returned.
    """
    seconds=min(8.,max(.01,float(seconds)))
    if not SLOTS.acquire(blocking=False):return {'status':'unavailable','sources':[]}
    deadline=time.monotonic()+seconds
    # Reserve page time instead of spending the entire budget on a hung engine.
    search_deadline=deadline-min(2.,seconds*.3)
    local=threading.Event();active=[];workers=[];lock=threading.Lock();box=queue.Queue()
    def stopped():return local.is_set() or cancel is not None and cancel.is_set()
    def launch(name, job, bound, sink=box):
        def work():
            try:
                left=max(.01,bound-time.monotonic())
                with client_factory(timeout=httpx.Timeout(left,connect=min(2.,left)),
                                    follow_redirects=False,trust_env=False) as client:
                    client._lookup_cancel=local;client._lookup_deadline=bound
                    with lock:active.append(client)
                    result=job(client) if not stopped() else {'status':'unavailable','sources':[]}
                    sink.put((name,result))
            except Exception:sink.put((name,{'status':'unavailable','sources':[]}))
        thread=threading.Thread(target=work,daemon=True,name='public-lookup')
        workers.append(thread);thread.start()
    jobs=[('duckduckgo',lambda c:dict(status='ok',sources=duckduckgo_sources(question,c))),
          ('bing',lambda c:dict(status='ok',sources=bing_sources(question,c))),
          ('wikipedia',lambda c:dict(status='ok',sources=wikipedia_sources(question,c)))]
    # Optional official results never exclude generic sources, even on API failure.
    if nobel_request(question) and re.search(r'(?<!\d)(20\d{2}|19\d{2})(?!\d)',question):
        jobs.append(('nobel',lambda c:lookup(question,c)))
    results=[];sources=[];remaining=len(jobs);grace=None
    try:
        for name, job in jobs:launch(name,job,search_deadline)
        while remaining and time.monotonic()<search_deadline and not stopped():
            bound=min(search_deadline,grace or search_deadline)
            if time.monotonic()>=bound:break
            try:name,result=box.get(timeout=min(.05,max(.001,bound-time.monotonic())))
            except queue.Empty:continue
            remaining-=1;results.append((name,result))
            sources=merge_sources(question,results)
            if name=='duckduckgo' and merge_sources(question,[(name,result)]):
                grace=min(search_deadline,time.monotonic()+.2)
        sources=merge_sources(question,results)
        page_box=queue.Queue();page_count=0
        if not stopped():
            for index, source in enumerate(sources[:2]):
                if time.monotonic()>=deadline:break
                page_count+=1
                page_deadline=min(deadline,time.monotonic()+2.)
                launch(index,lambda c,s=source:dict(body=fetch_page(s['url'],c,
                       deadline-time.monotonic())),page_deadline,page_box)
        while page_count and time.monotonic()<deadline and not stopped():
            try:index,page=page_box.get(timeout=min(.05,max(.001,deadline-time.monotonic())))
            except queue.Empty:continue
            page_count-=1
            if page.get('body'):sources[index]['body']=page['body']
        if sources:status='ok'
        elif any(r.get('status') in ('ok','empty') for _,r in results):status='empty'
        else:status='unavailable'
        # Empty means only no evidence retrieved, never a claim of nonexistence.
        return {'status':status,'sources':sources,'answer':None,
                'searched_at':datetime.now().astimezone().isoformat(),
                'engines':[{ 'name':name,'status':r.get('status')} for name,r in results]}
    finally:
        local.set()
        with lock:clients=list(active)
        for client in clients:
            def close(c=client):
                try:c.close()
                except Exception:pass
            threading.Thread(target=close,daemon=True).start()
        def release():
            for thread in workers:thread.join()
            SLOTS.release()
        threading.Thread(target=release,daemon=True).start()
