import { useEffect, useRef, useState } from "react";
import { toolLabel, processCopy } from "./chat-copy";
import type { ChatMessage } from "./types";
import { formatChatDuration } from "./chat-duration";
import "./chat-steps.css";
const phases = ["正在查询预测…", "正在查询调度…", "正在查询回执…"];
export function StepIcon({ web = false }: { web?: boolean }) {
  return (
    <svg
      className="agent-step-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {web ? (
        <>
          <circle cx="10" cy="10" r="7.5" />
          <ellipse cx="10" cy="10" rx="3.3" ry="7.5" />
          <path d="M2.5 10h15M4 6h12M4 14h7" />
          <circle cx="16.5" cy="16.5" r="4" />
          <path d="m19.5 19.5 3 3" />
        </>
      ) : (
        <>
          <path d="M4 5h16M4 12h16M4 19h16" />
          <circle cx="9" cy="5" r="2" fill="var(--panel-bg, #14222b)" />
          <circle cx="15" cy="12" r="2" fill="var(--panel-bg, #14222b)" />
          <circle cx="8" cy="19" r="2" fill="var(--panel-bg, #14222b)" />
        </>
      )}
    </svg>
  );
}
export function StepDots() {
  return (
    <span className="agent-step-dots" aria-label="…">
      {[0, 1, 2].map((i) => (
        <span key={i} aria-hidden="true">
          .
        </span>
      ))}
    </span>
  );
}
export function ChatProcess({
  message: m,
  displayText = (s) => s,
}: {
  message: ChatMessage;
  displayText?: (text: string) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const rows = m.process ?? [],
    list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (m.pending && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [m.process, m.pending]);
  const count = rows.filter((r) => r.kind === "tool").length,
    seconds = (m.elapsed ?? 0) / 1000;
  if (!m.pending && count === 0) return null;
  return (
    <details className="agent-chat-process" open={m.pending || expanded}>
      <summary
        aria-expanded={Boolean(m.pending || expanded)}
        onClick={(e) => {
          e.preventDefault();
          if (!m.pending) setExpanded(!expanded);
        }}
      >
        {m.pending ? (
          <span role="status">
            {m.fallback
              ? phases[Math.floor(seconds / 2) % phases.length]
              : "工具执行过程"}{" "}
            · 已用 {formatChatDuration(m.elapsed ?? 0)}
          </span>
        ) : (
          `已调用 ${count} 个工具 · ${formatChatDuration(m.elapsed ?? 0)} · ${expanded ? "收起" : "查看详情"}`
        )}
      </summary>
      <ol
        ref={list}
        aria-label="问答工具过程"
        className="agent-process-list"
        tabIndex={0}
      >
        {rows.map((row) => {
          const tool = row.kind === "tool",
            running = tool
              ? row.state === "running"
              : row.kind === "progress" && m.pending,
            label = tool
              ? toolLabel(row.tool || "", row.name)
              : processCopy(displayText(row.text)).replace(/[.…]+$/, "");
          return (
            <li
              key={row.id}
              className={`agent-process-${row.kind}`}
              data-tool-state={row.state}
              data-progress-id={row.progressId}
              data-step-running={running || undefined}
              data-tool={row.tool}
            >
              {tool || row.kind === "progress" ? (
                <>
                  <div className="agent-step-line">
                    <span
                      className="agent-step-symbol"
                      aria-label={
                        running
                          ? "执行中"
                          : row.state === "done"
                            ? "已完成"
                            : row.state === "error"
                              ? "未完成"
                              : undefined
                      }
                    >
                      {running ? (
                        <StepIcon web={row.tool === "web_search"} />
                      ) : row.state === "done" ? (
                        "✓"
                      ) : (
                        "!"
                      )}
                    </span>
                    <span className="agent-step-label">
                      {label}
                      {tool && running ? "中" : ""}
                      {running && <StepDots />}
                    </span>
                    {tool && row.state === "done" && row.ms !== undefined && (
                      <small className="agent-step-time">
                        {" "}
                        · {formatChatDuration(row.ms)}
                      </small>
                    )}
                  </div>
                  {tool &&
                    row.state !== "running" &&
                    (row.summary || row.text) && (
                      <p>{processCopy(displayText(row.summary || row.text))}</p>
                    )}
                </>
              ) : (
                displayText(row.text)
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
