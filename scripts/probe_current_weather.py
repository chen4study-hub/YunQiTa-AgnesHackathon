"""Fixed real HTTP checks for current versus future weather; one pass, all outcomes saved."""
from scripts.probe_chat_stream10 import main

if __name__=='__main__':
    main(['现在几点、天气怎么样？','天气怎么样','未来几小时天气怎么样'],prefix='chat_current_weather')
