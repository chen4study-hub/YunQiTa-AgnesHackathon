"""Answer scope helpers shared by both pipelines; no data lookup or device writes."""
import re


def two_sentences(question):
    return bool(re.search(r'两句|2\s*句', question))


def sentence_count(text):
    return len([s for s in re.split(r'[。！？!?]', text) if s.strip()])


def compact_day_words(text):
    """Keep one next-day qualifier per sentence; semicolons inherit the day.

    A switch back to today's clocks starts a new sentence. Never remove the
    next-day qualifier from the first clock, or rewrite source URLs/dates.
    """
    out=[];day=None
    for token in re.split(r'(https?://[^\s<>）)]+|今天|次日|[。！？!?\n])', text):
        if token.startswith(('http://','https://')):
            out.append(token)
        elif token in ('今天','次日'):
            if day == token:
                continue
            if day is not None and day != token:
                # Make the day transition explicit even in a long exclusion list.
                if out and out[-1].endswith(('；','，')):out[-1]=out[-1][:-1]+'。'
            day=token;out.append(token)
        else:
            out.append(token)
            if token in ('。','！','？','!','?','\n'):day=None
    return ''.join(out)


def typhoon_question(question):
    return '台风' in question and bool(re.search(r'影响|有没有|是否|有吗', question))


TYPHOON_NO_EVIDENCE='现有工具数据没有可核实台风影响的依据，不能据天气读数判断有无台风影响。'


def typhoon_claim_issue(answer, question):
    if not typhoon_question(question):return False
    # These tools supply weather readings/reports, not a causal impact assessment.
    # Do not treat sunshine, rain or the absence of news as absence of impact.
    claim_text=re.sub(r'不能[^。！？]*|无法[^。！？]*|未查到[^。！？]*|没有[^。！？]*依据', '', answer)
    claims=re.search(r'(?:当前|今天|当地|上海|北京)?(?:没有|无|未受|不受|受到|有)(?:明显|显著)?台风影响|台风.*?(?:没有影响|影响不大|影响不明显|正在影响)',claim_text)
    no_basis=bool(re.search(r'没有.*依据|没.*依据|缺乏.*依据|无法.*(?:确认|判断)|不能.*(?:确认|判断)|未查到.*(?:影响|资料|依据)',answer))
    return bool(claims) or not no_basis
