import threading
from experiments.agent_v3_20261013.semantic_assertions import check
from src.agent.agent_tools import run_tool
from tests.test_agent_v3 import fixture


def record(name,question,args=None):
    d,r=fixture()
    return run_tool(name,args or {},d,r,'2026-10-13','14:00',2,threading.Event(),question)


def test_floor_single_field_accepts_concise_but_not_wrong_floor_or_value():
    q='27层CO₂是多少';r=record('floor_state',q,{'floor':27})
    c={'question':q,'tool':'floor_state','semantic_check':'floor_field','expected_field':'co2_ppm','expected_unit':'ppm'}
    assert check(c,'27层 CO₂ 550.0 ppm。',[r])
    assert not check(c,'27层 CO₂ 768.0 ppm。',[r])
    assert not check(c,'18层 CO₂ 550.0 ppm。',[r])


def test_cost_only_retains_actual_value_and_rejects_wrong_cost():
    q='2026-10-10电费是多少';r=record('energy_totals',q,{'date':'2026-10-10'})
    c={'question':q,'tool':'energy_totals','semantic_check':'energy_cost'}
    assert check(c,'电费 21,092.5 元。',[r])
    assert not check(c,'电费 20,000.0 元。',[r])


def test_lift_record_not_proof_of_health():
    q='电梯运行正常吗';r=record('elevator_state',q)
    c={'question':q,'tool':'elevator_state','semantic_check':'lift_health'}
    assert check(c,r['reference'],[r])
    assert not check(c,'电梯都正常，当前在1层。',[r])


def test_empty_news_no_fabricated_reports_or_weather_substitution():
    c={'question':'北京天气新闻','tool':'web_search','semantic_check':'news'}
    r={'success':True,'data':{'recent_news':True,'sources':[]},'trace':[{'tool':'web_search','result':{'recent_news':True,'sources':[]}}]}
    assert check(c,'没查到相关报道。',[r])
    assert not check(c,'北京当前晴，气温20°C。',[r])
    assert not check(c,'查到一条相关报道：北京暴雨。',[r])
