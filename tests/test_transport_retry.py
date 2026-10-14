import httpx,pytest
from src.agent.provider import post_with_retry
from src.agent import provider


@pytest.mark.parametrize('failure',['500','timeout'])
def test_one_backoff_then_success(monkeypatch,failure):
    sleep=[];monkeypatch.setattr(provider.time,'sleep',sleep.append)
    class Client:
        calls=0
        def post(self,*a,**k):
            self.calls+=1
            if self.calls==1:
                if failure=='timeout':raise httpx.ReadTimeout('suppressed')
                return httpx.Response(500,request=httpx.Request('POST','https://example.test'))
            return httpx.Response(200,request=httpx.Request('POST','https://example.test'))
    c=Client();r,attempts=post_with_retry(c,'unused')
    assert c.calls==2 and sleep==[.5] and len(attempts)==2
    assert attempts[-1]['reason']=='transport_succeeded'


@pytest.mark.parametrize('code',[401,403,429,502])
def test_other_errors_not_retried(monkeypatch,code):
    monkeypatch.setattr(provider.time,'sleep',lambda *a:pytest.fail('no retry'))
    class Client:
        calls=0
        def post(self,*a,**k):self.calls+=1;return httpx.Response(code,request=httpx.Request('POST','https://example.test'))
    c=Client()
    with pytest.raises(httpx.HTTPStatusError):post_with_retry(c,'unused')
    assert c.calls==1


def test_chat_timeout_not_retried_and_500_is(monkeypatch):
    monkeypatch.setattr(provider.time,'sleep',lambda *a:None)
    class Client:
        calls=0
        def post(self,*a,**k):self.calls+=1;raise httpx.ReadTimeout('suppressed')
    c=Client()
    with pytest.raises(httpx.ReadTimeout):post_with_retry(c,'unused',retry_timeouts=False,max_seconds=10)
    assert c.calls==1


def test_persistent_timeout_stops_after_two(monkeypatch):
    monkeypatch.setattr(provider.time,'sleep',lambda *a:None)
    class Client:
        calls=0
        def post(self,*a,**k):self.calls+=1;raise httpx.ReadTimeout('private message')
    c=Client()
    with pytest.raises(httpx.ReadTimeout) as e:post_with_retry(c,'unused')
    assert c.calls==2 and len(e.value.safe_transport_attempts)==2
    assert 'private message' not in str(e.value.safe_transport_attempts)
