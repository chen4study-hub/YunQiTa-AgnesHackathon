import type { ChatMessage, Decision } from "./types";
import type { ReplayData } from "../../data/types";
import { streamChat, type ChatStreamEvent } from "./chat-stream";
import { chatRetrySeconds } from "./chat-rate-limit";

import { alignAnswer } from "./chat-data";
import { localDateKey, localClockText } from "../../config/localClock";
export interface ChatSnapshot {
  messages: ChatMessage[];
  busy: boolean;
  sessionId: string;
  terminated: boolean;
  retryAt: number;
  draft: string;
}
const empty: ChatSnapshot = {
  messages: [],
  busy: false,
  sessionId: "",
  terminated: false,
  retryAt: 0,
  draft: "",
};
const newSession = (): ChatSnapshot => ({
  ...empty,
  sessionId: crypto.randomUUID(),
});
const storageKey = "yunqi-agent-chat-v1";
/** Agent-only tab session. It owns the request, not a mounted page. */
export class AgentChatSession {
  private snapshot: ChatSnapshot = newSession();
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private generation = 0;
  private sequence = 0;
  constructor(private storage?: Pick<Storage, "getItem" | "setItem">) {
    try {
      const saved = JSON.parse(storage?.getItem(storageKey) ?? "null");
      if (saved?.version === 1 && Array.isArray(saved.messages)) {
        const messages: ChatMessage[] = saved.messages
          .slice(-60)
          .filter(
            (m: any) =>
              m &&
              typeof m.id === "number" &&
              Number.isFinite(m.id) &&
              ["user", "assistant"].includes(m.role) &&
              typeof m.text === "string" &&
              m.text.length <= 14000 &&
              Array.isArray(m.tools) &&
              m.tools.every((t: any) => typeof t === "string") &&
              ["preset", "backend"].includes(m.source),
          )
          .map((m: ChatMessage) => ({
            ...m,
            displayContext:
              m.displayContext &&
              typeof m.displayContext.scenario === "string" &&
              typeof m.displayContext.origin === "string" &&
              Number.isFinite(Date.parse(m.displayContext.origin)) &&
              Number.isFinite(m.displayContext.nowMs)
                ? m.displayContext
                : undefined,
            rateLimit:
              m.rateLimit &&
              typeof m.rateLimit.retryAt === "number" &&
              Number.isFinite(m.rateLimit.retryAt)
                ? { retryAt: m.rateLimit.retryAt }
                : undefined,
            pending: false,
            process: [],
            requestError: Boolean(m.requestError || m.pending),
            text: m.text,
          }));
        this.sequence = Math.max(0, ...messages.map((m) => m.id));
        this.snapshot = {
          messages,
          busy: false,
          sessionId:
            typeof saved.sessionId === "string" &&
            saved.sessionId.length > 0 &&
            saved.sessionId.length <= 128
              ? saved.sessionId
              : this.snapshot.sessionId,
          retryAt:
            typeof saved.retryAt === "number" && Number.isFinite(saved.retryAt)
              ? saved.retryAt
              : 0,
          draft:
            typeof saved.draft === "string" ? saved.draft.slice(0, 2000) : "",
          terminated:
            saved.terminated === true ||
            messages.some((m: ChatMessage) => m.terminated === true),
        };
      }
    } catch {
      /* Disabled storage or corrupt history must not prevent chatting. */
    }
    this.publish(this.snapshot);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: ChatSnapshot) {
    this.snapshot = snapshot;
    try {
      this.storage?.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          sessionId: snapshot.sessionId,
          terminated: snapshot.terminated,
          retryAt: snapshot.retryAt,
          draft: snapshot.draft,
          messages: snapshot.messages.slice(-60),
        }),
      );
    } catch {
      /* In-memory session still works on quota/security errors. */
    }
    this.listeners.forEach((fn) => fn());
  }
  setDraft = (draft: string) => {
    this.publish({ ...this.snapshot, draft: draft.slice(0, 2000) });
  };
  cancel = () => {
    this.controller?.abort();
    this.controller = null;
    this.publish({
      ...this.snapshot,
      busy: false,
      messages: this.snapshot.messages.map((m) =>
        m.pending
          ? {
              ...m,
              pending: false,
              process: (m.process ?? [])
                .filter((r) => r.kind !== "progress")
                .map((r) =>
                  r.state === "running" ? { ...r, state: "error" as const } : r,
                ),
            }
          : m,
      ),
    });
  };
  reset = () => {
    ++this.generation;
    this.controller?.abort();
    this.controller = null;
    // A new conversation cannot bypass the server cooldown.
    this.publish({ ...newSession(), retryAt: this.snapshot.retryAt });
  };
  async send(
    question: string,
    context: {
      data: ReplayData;
      index: number;
      scenario: string;
      nowMs: number;
      decision: Decision;
      labelOrigin: string;
    },
  ) {
    const q = question.trim();
    if (
      !q ||
      this.snapshot.busy ||
      this.snapshot.terminated ||
      chatRetrySeconds(this.snapshot.retryAt) > 0
    )
      return;
    const generation = this.generation,
      userId = ++this.sequence,
      id = ++this.sequence,
      start = performance.now();
    const controller = new AbortController();
    this.controller = controller;
    const current = () =>
      this.generation === generation && !controller.signal.aborted;
    const update = (fn: (m: ChatMessage) => ChatMessage) => {
      if (current())
        this.publish({
          ...this.snapshot,
          messages: this.snapshot.messages.map((m) =>
            m.id === id ? fn(m) : m,
          ),
        });
    };
    this.publish({
      ...this.snapshot,
      busy: true,
      draft: "",
      messages: [
        ...this.snapshot.messages,
        {
          id: userId,
          role: "user",
          source: "preset",
          tools: [],
          text: q,
          displayContext: {
            scenario: context.scenario,
            origin: context.decision.t,
            nowMs: context.nowMs,
          },
        },
        {
          id,
          displayContext: {
            scenario: context.scenario,
            origin: context.decision.t,
            nowMs: context.nowMs,
          },
          role: "assistant",
          source: "backend",
          tools: [],
          text: "",
          pending: true,
          elapsed: 0,
          process: [],
        },
      ],
    });
    const tick = setInterval(
      () => update((m) => ({ ...m, elapsed: performance.now() - start })),
      1000,
    );
    // Request-local monotonic starts; repeated tools retain independent timings.
    const toolStarts = new Map<number, number>();
    const event = (e: ChatStreamEvent) => {
      const terminal = e.type === "error" || e.type === "done";
      if (terminal && current() && this.controller === controller)
        this.publish({
          ...this.snapshot,
          busy: false,
          terminated:
            this.snapshot.terminated ||
            (e.type === "done" && e.terminated === true),
        });
      update((m) => {
        const clearsWait = [
          "answer_delta",
          "done",
          "error",
          "fallback",
        ].includes(e.type);
        const rows = (m.process ?? []).filter(
          (r) =>
            !(terminal && r.kind === "progress") &&
            (!clearsWait || r.progressId !== "chat-answer-wait") &&
            (!(clearsWait || e.type === "tool_end") ||
              r.progressId !== "chat-tool-wait"),
        );
        let rowId = Math.max(0, ...rows.map((r) => r.id));
        if (e.type === "progress") {
          if (!m.pending) return m;
          if (
            e.id === "chat-answer-wait" &&
            (m.text || !m.pending || m.waitFinished)
          )
            return m;
          const index = rows.findIndex((r) => r.progressId === e.id),
            row = {
              id: index >= 0 ? rows[index].id : ++rowId,
              kind: "progress" as const,
              progressId: e.id,
              text: e.text,
            };
          if (index >= 0) rows[index] = row;
          else rows.push(row);
          return { ...m, process: rows };
        }
        if (e.type === "answer_delta")
          return {
            ...m,
            text: m.text + e.text,
            process: rows,
            waitFinished: true,
          };
        if (e.type === "fallback")
          return {
            ...m,
            fallback: true,
            text: "",
            waitFinished: true,
            process: [
              ...rows,
              {
                id: ++rowId,
                kind: "step",
                text: "流式回答未完成，改用普通问答接口。",
              },
            ],
          };
        if (e.type === "step") {
          if (/^正在/.test(e.text.trim())) {
            // Legacy tool-status narration is transient, not a historical step.
            const index = rows.findIndex(
              (r) => r.progressId === "chat-tool-wait",
            );
            const row = {
              id: index >= 0 ? rows[index].id : ++rowId,
              kind: "progress" as const,
              progressId: "chat-tool-wait",
              text: e.text,
            };
            if (index >= 0) rows[index] = row;
            else rows.push(row);
          } else rows.push({ id: ++rowId, kind: "step", text: e.text });
        }
        if (e.type === "tool_start") {
          let args = "";
          try {
            args = JSON.stringify(e.args ?? {}).slice(0, 180);
          } catch {
            args = "参数不可显示";
          }
          toolStarts.set(++rowId, performance.now());
          rows.push({
            id: rowId,
            kind: "tool",
            tool: e.tool,
            name: e.name,
            text: args,
            state: "running",
          });
        }
        if (e.type === "tool_end") {
          let index = -1;
          for (let i = rows.length - 1; i >= 0; i--)
            if (rows[i].tool === e.tool && rows[i].state === "running") {
              index = i;
              break;
            }
          const started =
            index >= 0 ? toolStarts.get(rows[index].id) : undefined;
          const row = {
            id: index >= 0 ? rows[index].id : ++rowId,
            kind: "tool" as const,
            tool: e.tool,
            name: index >= 0 ? rows[index].name : undefined,
            text: "",
            state: "done" as const,
            ms:
              e.ms ??
              (started === undefined
                ? undefined
                : Math.max(0, performance.now() - started)),
            summary: e.summary,
          };
          toolStarts.delete(row.id);
          if (index >= 0) rows[index] = row;
          else rows.push(row);
        }
        if (e.type === "error")
          rows.push({ id: ++rowId, kind: "error", text: e.message });
        return {
          ...m,
          process: terminal
            ? rows.map((r) =>
                r.state === "running" ? { ...r, state: "error" as const } : r,
              )
            : rows,
          pending: terminal ? false : m.pending,
          terminated: e.type === "done" ? e.terminated === true : m.terminated,
          category: e.type === "done" ? e.category : m.category,
          waitFinished: m.waitFinished || clearsWait,
        };
      });
    };
    try {
      const { data, index, scenario, nowMs, decision, labelOrigin } = context;
      const result = await streamChat(
        q,
        scenario,
        decision.t,
        event,
        controller.signal,
        localDateKey(nowMs),
        localClockText(nowMs).slice(0, 5),
        this.snapshot.sessionId,
      );
      if (!current()) return;
      if (result?.rateLimit) {
        update((m) => ({
          ...m,
          ...result,
          pending: false,
          process: [],
          fallback: undefined,
          requestError: false,
          needsHuman: false,
          terminated: false,
          category: undefined,
        }));
        this.publish({
          ...this.snapshot,
          retryAt: result.rateLimit.retryAt,
          draft: question.slice(0, 2000),
        });
        return;
      }
      if (result?.terminated)
        this.publish({ ...this.snapshot, terminated: true });
      const answer = alignAnswer(result, q, decision, data, index, labelOrigin);
      update((m) => ({
        ...m,
        ...answer,
        pending: false,
        elapsed: performance.now() - start,
        needsHuman: result?.needsHuman,
        process:
          m.fallback && result
            ? [
                ...(m.process ?? []).map((r) =>
                  r.state === "running"
                    ? {
                        ...r,
                        state: "error" as const,
                        summary: "未收到工具完成事件",
                      }
                    : r,
                ),
                ...result.tools.map((tool, i) => ({
                  id:
                    Math.max(0, ...(m.process ?? []).map((r) => r.id)) + i + 1,
                  kind: "tool" as const,
                  tool,
                  text: "普通接口提供的工具记录",
                  state: "done" as const,
                  summary: "普通接口工具记录（未提供分步耗时）",
                })),
              ]
            : (m.process ?? [])
                .filter((r) => r.progressId !== "chat-answer-wait")
                .map((r) =>
                  r.state === "running"
                    ? { ...r, state: "error", summary: "未收到工具完成事件" }
                    : r,
                ),
      }));
    } catch {
      update((m) => ({
        ...m,
        requestError: true,
        pending: false,
        process: (m.process ?? []).filter((r) => r.kind !== "progress"),
      }));
    } finally {
      clearInterval(tick);
      update((m) => ({
        ...m,
        pending: false,
        process: (m.process ?? [])
          .filter((r) => r.kind !== "progress")
          .map((r) =>
            r.state === "running" ? { ...r, state: "error" as const } : r,
          ),
      }));
      if (this.generation === generation && this.controller === controller) {
        this.controller = null;
        this.publish({ ...this.snapshot, busy: false });
      }
    }
  }
}
let session: AgentChatSession | undefined;
export function agentChatSession(): AgentChatSession {
  if (!session) {
    let storage: Storage | undefined;
    try {
      storage =
        typeof window !== "undefined" ? window.sessionStorage : undefined;
    } catch {}
    session = new AgentChatSession(storage);
  }
  return session;
}
export const serverChatSnapshot = () => empty;
