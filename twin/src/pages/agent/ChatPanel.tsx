import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ReplayData } from "../../data/types";
import { Card } from "../../components/Card";
import type { ChatMessage, Decision } from "./types";
import { agentChatSession, serverChatSnapshot } from "./chat-session";
import { ChatReply } from "./ChatAnswerText";
import { ChatLlmNotice } from "./ChatLlmNotice";
import { LlmStatusBadge } from "./LlmStatusBadge";
import { ChatToolTags } from "./ChatToolTags";
import { ChatProcess } from "./ChatProcess";
import { ChatRateLimitNotice, useChatRetryClock } from "./ChatRateLimitNotice";
import { chatRetrySeconds } from "./chat-rate-limit";
import { quickQuestions } from "./chat-data";
import { replayCalendar } from "../../ui/replayCalendar";
import { displayConclusions } from "../displayConclusions";

export function ChatPanel({
  data,
  index,
  scenario,
  nowMs,
  decision,
  labelOrigin = decision.t,
  online,
  onHealthRefresh,
}: {
  data: ReplayData;
  index: number;
  scenario: string;
  nowMs: number;
  labelOrigin?: string;
  decision: Decision;
  online?: boolean;
  onHealthRefresh?: () => void;
}) {
  const calendar = replayCalendar(scenario, decision.t, nowMs).text;
  const messageText = (m: ChatMessage, text: string) => {
    const c = m.displayContext;
    return displayConclusions(
      c
        ? replayCalendar(c.scenario, c.origin, c.nowMs).text(text)
        : calendar(text),
    );
  };
  const session = agentChatSession();
  const {
    messages,
    busy,
    terminated,
    retryAt,
    draft: input,
  } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    serverChatSnapshot,
  );
  const now = useChatRetryClock(retryAt);
  const coolingDown = chatRetrySeconds(retryAt, now) > 0;
  const setInput = session.setDraft;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({
      top: list.current.scrollHeight,
      behavior: "auto",
    });
  }, [messages, busy]);
  async function send(question: string) {
    if (!question.trim() || busy || terminated || coolingDown) return;
    await session.send(question, {
      data,
      index,
      scenario,
      nowMs,
      decision,
      labelOrigin,
    });
    onHealthRefresh?.();
  }
  return (
    <Card label="运维问答" className="agent-chat-card">
      <header className="agent-heading">
        <div>
          <h2>运维问答</h2>
          <small>运维问答 · 时刻与左侧一致</small>
        </div>
        <div className="agent-chat-header-actions">
          <button
            type="button"
            onClick={() => {
              session.reset();
              setInput("");
            }}
          >
            新会话
          </button>
          <LlmStatusBadge online={online} />
        </div>
      </header>
      <ChatLlmNotice online={online} messages={messages} />
      <div
        className="agent-chat-messages"
        ref={list}
        role="log"
        aria-label="运维对话"
        aria-live="polite"
      >
        <div className="agent-bubble agent-assistant agent-chat-welcome">
          <small>Agent · 运维助手</small>
          <p>选择快捷问题，或直接输入运维问题。</p>
        </div>
        {messages.map((m) => (
          <div key={m.id} className={`agent-bubble agent-${m.role}`}>
            <small>
              {m.role === "user"
                ? "值班工程师"
                : m.rateLimit
                  ? "Agent · 提问提示"
                  : m.source === "backend"
                    ? "Agent · 服务端回答"
                    : "Agent · 预置回答"}
            </small>
            {m.rateLimit && (
              <ChatRateLimitNotice retryAt={m.rateLimit.retryAt} now={now} />
            )}
            {m.role === "assistant" && !m.rateLimit && m.process && (
              <ChatProcess
                message={m}
                displayText={(text) => messageText(m, text)}
              />
            )}
            {(m.text || m.terminated) &&
              (m.role === "assistant" ? (
                <ChatReply
                  text={m.text}
                  pending={m.pending}
                  needsHuman={m.needsHuman}
                  terminated={m.terminated}
                  category={m.category}
                  displayText={
                    m.source === "backend"
                      ? (text) => text
                      : (text) => messageText(m, text)
                  }
                />
              ) : (
                <p>{messageText(m, m.text)}</p>
              ))}
            {m.requestError && !m.pending && (
              <p className="agent-chat-request-error" role="alert">
                问答请求未完成，请稍后重试。
              </p>
            )}
            {m.tools.length > 0 && (
              <ChatToolTags tools={m.tools} toolNames={m.toolNames} />
            )}
          </div>
        ))}
      </div>
      {terminated && (
        <p className="agent-chat-ended" role="status">
          本会话已结束，请开启新会话
        </p>
      )}
      <div className="agent-quick-questions">
        {quickQuestions.map((q) => (
          <button
            type="button"
            key={q}
            disabled={busy || terminated || coolingDown}
            onClick={() => void send(q)}
          >
            {q}
          </button>
        ))}
      </div>
      <form
        className="agent-chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label className="agent-sr-only" htmlFor="agent-question">
          运维问题
        </label>
        <input
          id="agent-question"
          value={input}
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          placeholder="询问调度依据、预测峰值或人工检查…"
          disabled={busy || terminated}
        />
        <button
          type="submit"
          disabled={busy || terminated || coolingDown || !input.trim()}
        >
          发送
        </button>
      </form>
    </Card>
  );
}
