"""Pass ranked search evidence through; semantic relevance belongs to the model."""
from .web_search import news_request


def is_news_question(question):
    from .chat_router import building_reading_question
    return news_request(question) and ('新闻' in question or not building_reading_question(question))


def relevant(question, source):
    # Compatibility: this means retained for model inspection, not proven
    # relevant. Title overlap cannot decide semantic relevance.
    return True


def filter_result(question, result):
    # Search owns ranking; preserve original title/snippet/body/order for the
    # model to judge. No keyword filter, including weather/news candidates.
    if is_news_question(question):
        from .agent_public import source_reference
        # Legacy direct_recent_news consumes answer, while generic search may
        # omit it or return None. Restore the display contract without pruning
        # ranked evidence or requiring published_at on every fallback source.
        answer = (result.get('answer') or source_reference(result)) if result.get('sources') else '没查到相关报道。'
        return {**result, 'recent_news': True, 'lookback_days': result.get('lookback_days', 14),
                'answer': answer}
    return result
