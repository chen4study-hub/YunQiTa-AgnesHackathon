import { displayDate as currentDisplayDate } from "../../config/displayClock";
import { apiBase, chat, CHAT_TIMEOUT_MS } from "./api";
import { answerCopy, chatReason, type ChatReason } from "./chat-copy";
import { object } from "./data";
import type { ChatAnswer } from "./types";
import { readChatRateLimit, rateLimitAnswer } from "./chat-rate-limit";

export type ChatStreamEvent =
  | { type: "step"; text: string }
  | { type: "progress"; id: string; text: string; elapsed_seconds: number }
  | { type: "tool_start"; tool: string; name?: string; args: unknown }
  | { type: "tool_end"; tool: string; ms?: number; summary: string }
  | { type: "answer_delta"; text: string }
  | {
      type: "done";
      known: boolean;
      needs_human: boolean;
      grounded: boolean;
      reason?: ChatReason;
      mode?: "llm" | "fallback";
      terminated?: boolean;
      category?: string;
    }
  | { type: "error"; message: string }
  | { type: "fallback" };
export interface StreamAnswer extends ChatAnswer {
  needsHuman?: boolean;
}

/** SSE data lines (or JSONL), independent of TCP/UTF-8 chunk boundaries. */
export function eventLine(
  line: string,
  eventType = "",
): ChatStreamEvent | null {
  const content = line.startsWith("data:")
    ? line.slice(5).trimStart()
    : line.trim();
  if (!content || content.startsWith(":")) return null;
  const r = object(JSON.parse(content));
  const type = typeof r.type === "string" ? r.type : eventType;
  const text = (value: unknown) =>
    typeof value === "string" ? value.slice(0, 12000) : "";
  switch (type) {
    case "step":
      return { type, text: text(r.text) };
    case "progress":
      if (
        typeof r.id !== "string" ||
        !r.id ||
        typeof r.elapsed_seconds !== "number" ||
        !Number.isFinite(r.elapsed_seconds)
      )
        return null;
      return {
        type,
        id: text(r.id),
        text: text(r.text),
        elapsed_seconds: Math.max(0, r.elapsed_seconds),
      };
    case "tool_start":
      return {
        type,
        tool: text(r.tool),
        ...(typeof r.name === "string" && r.name.trim()
          ? { name: text(r.name) }
          : {}),
        args: r.args,
      };
    case "tool_end":
      return {
        type,
        tool: text(r.tool),
        ms:
          typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0
            ? r.ms
            : undefined,
        summary: text(r.summary),
      };
    case "answer_delta":
      return { type, text: typeof r.text === "string" ? r.text : "" };
    case "done":
      return {
        type,
        known: r.known === true,
        needs_human: r.needs_human === true,
        grounded: r.grounded === true,
        terminated: r.terminated === true,
        category: typeof r.category === "string" ? r.category : undefined,
        mode: r.mode === "llm" || r.mode === "fallback" ? r.mode : undefined,
        ...(chatReason(r.reason) ? { reason: chatReason(r.reason) } : {}),
      };
    case "error":
      return { type, message: text(r.message) || "工具服务暂不可用" };
    default:
      return null;
  }
}

export async function streamChat(
  question: string,
  scenario: string,
  origin: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  displayDate = currentDisplayDate(),
  displayTime?: string,
  sessionId?: string,
): Promise<StreamAnswer | null> {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, CHAT_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let answer = "",
    events = 0;
  const tools: string[] = [];
  const toolNames: Record<string, string> = Object.create(null);
  let explicitError = false;
  let final: Extract<ChatStreamEvent, { type: "done" }> | undefined;
  try {
    const response = await fetch(`${apiBase()}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        question,
        scenario,
        origin,
        display_date: displayDate,
        display_time: displayTime,
        session_id: sessionId,
      }),
      signal: controller.signal,
    });
    // Rejected before SSE starts: never retry /chat or synthesize an answer.
    if (response.status === 429) {
      const error = await readChatRateLimit(response);
      return signal?.aborted ? null : rateLimitAnswer(error);
    }
    if (!response.ok || !response.body) throw new Error("流式接口不可用");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "",
      eventType = "";
    const consume = (line: string) => {
      if (!line.trim()) {
        eventType = "";
        return;
      }
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
        return;
      }
      if (!line.startsWith("data:") && !line.trimStart().startsWith("{"))
        return;
      if (final) return;
      if (++events > 512) throw new Error("工具事件过多");
      const event = eventLine(line, eventType);
      if (!event) return;
      if (event.type === "answer_delta") {
        answer += event.text;
      }
      if (event.type === "tool_start") {
        tools.push(event.tool);
        if (event.name) toolNames[event.tool] = event.name;
      }
      if (event.type === "done") final = event;
      if (event.type === "error") {
        explicitError = true;
        onEvent(event);
        throw new Error(event.message);
      }
      onEvent(event);
    };
    while (!final) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 65536) throw new Error("事件行过长");
      if (chunk.done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (!final) throw new Error("连接中断，回答未完成");

    return {
      source: "backend",
      tools,
      toolNames,
      needsHuman: final.needs_human,
      terminated: final.terminated,
      category: final.category,
      mode: final.mode,
      text: answerCopy(
        final.known,
        final.needs_human,
        answer,
        tools,
        final.reason,
      ),
    };
  } catch {
    if (signal?.aborted) return null;
    if (explicitError)
      return {
        source: "backend",
        tools,
        toolNames,
        text: answer,
        requestError: true,
      };
    onEvent({ type: "error", message: "流式回答未完成，尝试普通问答接口。" });
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
    reader = undefined;
    onEvent({ type: "fallback" });
    const result = await chat(
      question,
      scenario,
      origin,
      signal,
      displayDate,
      displayTime,
      sessionId,
    );
    if (signal?.aborted) return null;
    return (
      result ?? { source: "backend", tools: [], text: "", requestError: true }
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => undefined);
  }
}
