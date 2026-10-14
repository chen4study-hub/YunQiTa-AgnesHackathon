import { displayDate as currentDisplayDate } from "../../config/displayClock";
import { answerCopy, chatReason } from "./chat-copy";
import type { ReplayData } from "../../data/types";
import type { ChatAnswer, Decision } from "./types";
import { object, scheduleDecision } from "./data";
import {
  ChatRateLimitError,
  readChatRateLimit,
  rateLimitAnswer,
} from "./chat-rate-limit";

export function apiBase(
  query = typeof location === "undefined" ? "" : location.search,
): string {
  return (new URLSearchParams(query).get("api") || "/api").replace(/\/$/, "");
}
export async function request(
  path: string,
  body?: unknown,
  timeout = 1800,
  base = apiBase(),
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal: controller.signal,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (response.status === 429 && path === "/chat")
      throw await readChatRateLimit(response);
    if (!response.ok) throw new Error("接口不可用");
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export async function health(): Promise<boolean> {
  try {
    return (
      object(object(await request("/health", undefined, 1000)).llm).mode ===
      "real"
    );
  } catch {
    return false;
  }
}
// /schedule may also wait for grounded LLM selection and writes log receipts. Cache by origin; no automatic retry on timeout,
// tab remount, StrictMode or playback. The cache is not a real-device transaction.
const schedules = new Map<string, Promise<Decision | null>>();
export function invalidateSchedule(
  data: ReplayData,
  index: number,
  scenario: string,
  displayDate = currentDisplayDate(),
): void {
  schedules.delete(
    `${apiBase()}|${scenario}|${data.meta.building_id}|${data.hours[index].t}|${displayDate}`,
  );
}
export function loadSchedule(
  data: ReplayData,
  index: number,
  scenario: string,
  displayDate = currentDisplayDate(),
): Promise<Decision | null> {
  const hour = data.hours[index];
  const base = apiBase();
  const key = `${base}|${scenario}|${data.meta.building_id}|${hour.t}|${displayDate}`;
  const existing = schedules.get(key);
  if (existing) return existing;
  const end = new Date(Date.parse(hour.t) + 3_600_000).toISOString();
  const promise = request(
    "/schedule",
    {
      building_id: data.meta.building_id,
      scenario,
      start: hour.t,
      end,
      display_date: displayDate,
    },
    45_000,
    base,
  )
    .then((r) => scheduleDecision(r, data, index))
    .catch(() => null);
  schedules.set(key, promise);
  // At most three typical days of unique hourly dispatch requests per page session.
  if (schedules.size > 72) schedules.delete(schedules.keys().next().value!);
  return promise;
}
// Real LLM tool selection + answer can take several seconds each.
export const CHAT_TIMEOUT_MS = 45_000;
export async function chat(
  question: string,
  scenario: string,
  origin: string,
  signal?: AbortSignal,
  displayDate = currentDisplayDate(),
  displayTime?: string,
  sessionId?: string,
): Promise<ChatAnswer | null> {
  try {
    const r = object(
      await request(
        "/chat",
        {
          question,
          scenario,
          origin,
          display_date: displayDate,
          display_time: displayTime,
          session_id: sessionId,
        },
        CHAT_TIMEOUT_MS,
        apiBase(),
        signal,
      ),
    );
    const tools = Array.isArray(r.tool_trace)
      ? r.tool_trace
          .map(object)
          .flatMap((t) => (typeof t.tool === "string" ? [t.tool] : []))
      : [];
    return {
      text: answerCopy(
        r.known !== false,
        r.needs_human === true,
        typeof r.answer === "string" ? r.answer : "",
        tools,
        chatReason(r.reason),
      ),
      tools,
      source: "backend",
      llmMode: typeof r.llm_mode === "string" ? r.llm_mode : undefined,
      needsHuman: r.needs_human === true,
      terminated: r.terminated === true,
      category: typeof r.category === "string" ? r.category : undefined,
      mode: r.mode === "llm" || r.mode === "fallback" ? r.mode : undefined,
      requestError: typeof r.answer !== "string",
    };
  } catch (error) {
    if (signal?.aborted) return null;
    if (error instanceof ChatRateLimitError) return rateLimitAnswer(error);
    return { source: "backend", tools: [], text: "", requestError: true };
  }
}
