"""Fixed added questions, one pass only, separate from the original ten-question batch."""
from scripts.probe_chat_stream10 import main

if __name__=='__main__':
    main(['现在几点、天气怎么样？','今天几号','现在几点天气怎么样？'],prefix='chat_compact_extra')
