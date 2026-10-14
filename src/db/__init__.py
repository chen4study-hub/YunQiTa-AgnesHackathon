"""Stable integration entry points for scheduling and read-only question tools."""
from .connection import Database, database_path
from .repository import Repository
from .service import TakeoverService


def get_active_takeover(date, hour):
    return Repository(Database()).get_active(date, hour)


def record_chat_event(session_id, question, classification, reason, *, operator_id='system', request_id=None):
    """Write an append-only chat audit event in its own transaction; return the row ID."""
    return Repository(Database()).record_chat_event(session_id, question, classification, reason,
                                                   operator_id=operator_id, request_id=request_id)
