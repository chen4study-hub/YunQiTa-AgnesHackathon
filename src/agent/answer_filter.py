"""Remove reasoning before publication; handles tags split across stream chunks."""
import re


class ThinkFilter:
    def __init__(self):
        self.pending = ''
        self.depth = 0

    def feed(self, text, final=False):
        self.pending += text
        out = []
        while self.pending:
            start = self.pending.find('<')
            if start < 0:
                if not self.depth:
                    out.append(self.pending)
                self.pending = ''
                break
            prefix, rest = self.pending[:start], self.pending[start:]
            if not self.depth:
                out.append(prefix)
            end = rest.find('>')
            if end < 0:
                # Hold incomplete markup before exposing any fragment.
                self.pending = rest
                if final:
                    self.pending = ''
                break
            tag = rest[:end+1]
            if re.fullmatch(r'<think\s*>', tag, re.I):
                self.depth += 1
            elif re.fullmatch(r'</think\s*>', tag, re.I):
                self.depth = max(0, self.depth-1)
            elif not self.depth:
                out.append(tag)
            self.pending = rest[end+1:]
        return ''.join(out)


def strip_thoughts(text):
    # Some providers return the reasoning prefix without an opening tag. The
    # only safe whole-message treatment is to discard text before that close.
    opening = re.search(r'<think\s*>', text, re.I)
    closing = re.search(r'</think\s*>', text, re.I)
    if closing and (not opening or closing.start() < opening.start()):
        text = text[closing.end():]
    return ThinkFilter().feed(text, final=True)
