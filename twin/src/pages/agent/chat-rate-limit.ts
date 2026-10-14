import type { ChatAnswer } from "./types";

export const DEFAULT_CHAT_RETRY_SECONDS = 60;
export class ChatRateLimitError extends Error {
  constructor(readonly retryAt: number) {
    super("问答请求过于频繁");
    this.name = "ChatRateLimitError";
  }
}
function seconds(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))
    value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** HTTP delta-seconds/date wins; tolerate both flat and FastAPI detail JSON. */
export async function readChatRateLimit(
  response: Response,
): Promise<ChatRateLimitError> {
  const now = Date.now(),
    header = response.headers.get("Retry-After")?.trim();
  let wait = seconds(header);
  if (wait === undefined && header && !/^[-+\d.]+$/.test(header)) {
    const date = Date.parse(header);
    if (Number.isFinite(date))
      wait = Math.max(0, Math.ceil((date - now) / 1000));
  }
  if (wait === undefined) {
    try {
      const body = record(await response.json());
      for (const r of [body, record(body.detail)]) {
        for (const key of [
          "retry_after_seconds",
          "retry_after",
          "wait_seconds",
        ]) {
          wait = seconds(r[key]);
          if (wait !== undefined) break;
        }
        if (wait !== undefined) break;
      }
    } catch {
      /* Empty or malformed 429 JSON is still a rate limit, never a failed answer. */
    }
  }
  return new ChatRateLimitError(
    now + (wait ?? DEFAULT_CHAT_RETRY_SECONDS) * 1000,
  );
}
export function rateLimitAnswer(error: ChatRateLimitError): ChatAnswer {
  return {
    source: "backend",
    text: "",
    tools: [],
    rateLimit: { retryAt: error.retryAt },
  };
}
export function chatRetrySeconds(retryAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}
