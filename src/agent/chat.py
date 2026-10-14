"""Public JSON-chat facade; all execution also powers the SSE event pipeline."""
from src.agent.chat_engine import events,consume
from src.agent.chat_tools import future_forecast,future_context,execute,intent


def rule_answer(question,data,row,tool=None,setpoint=None):
    if tool is None:tool,setpoint=intent(question)
    return consume(execute(tool,question,data,row,setpoint))


def answer(question,data,row,provider=None,display_date=None,display_time=None):
    return consume(events(question,data,row,provider,display_date=display_date,display_time=display_time))
