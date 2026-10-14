import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventLine,
  streamChat,
  type ChatStreamEvent,
} from "../src/pages/agent/chat-stream";
afterEach(() => vi.unstubAllGlobals());
function response(events: unknown[], done = true) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        // Deliberately split every multibyte Chinese character across chunks.
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        if (done) c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
describe("chat SSE protocol", () => {
  it("sends display_date on SSE and preserves it in the 404 POST /chat fallback without altering origin", async () => {
    const origin = "2017-07-20T00:00:00-05:00";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ grounded: true, answer: "次日 01:00" })),
      );
    vi.stubGlobal("fetch", fetch);
    await streamChat(
      "峰值？",
      "peak",
      origin,
      () => {},
      undefined,
      "2026-10-13",
      "13:44",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, options] of fetch.mock.calls)
      expect(JSON.parse(options.body)).toEqual({
        question: "峰值？",
        scenario: "peak",
        origin,
        display_date: "2026-10-13",
        display_time: "13:44",
      });
  });
  it("accepts SSE data lines, JSONL and named events", () => {
    expect(eventLine('data: {"type":"step","text":"核对"}')).toEqual({
      type: "step",
      text: "核对",
    });
    expect(eventLine('{"text":"部分回答"}', "answer_delta")).toEqual({
      type: "answer_delta",
      text: "部分回答",
    });
    expect(eventLine(":heartbeat")).toBeNull();
  });
  it("decodes split UTF8, ordered events and the final grounded answer", async () => {
    const events = [
      { type: "step", text: "查询中" },
      { type: "tool_start", tool: "get_forecast", args: {} },
      { type: "tool_end", tool: "get_forecast", ms: 12, summary: "已核对" },
      { type: "answer_delta", text: "第一段。" },
      { type: "answer_delta", text: "第二段。" },
      { type: "done", known: true, grounded: true, needs_human: false },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(events)));
    const received: ChatStreamEvent[] = [];
    const result = await streamChat(
      "问题",
      "normal",
      "2017-01-01T14:00:00Z",
      (e) => received.push(e),
    );
    expect(received.map((e) => e.type)).toEqual(events.map((e) => e.type));
    expect(result?.text).toBe("第一段。第二段。");
    expect(result?.tools).toEqual(["get_forecast"]);
  });
  it("falls back once on 404", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ grounded: true, answer: "普通回答" })),
      );
    vi.stubGlobal("fetch", fetch);
    const received: ChatStreamEvent[] = [];
    expect(
      (
        await streamChat("问题", "normal", "2017-01-01T14:00:00Z", (e) =>
          received.push(e),
        )
      )?.text,
    ).toBe("普通回答");
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "/api/chat/stream",
      "/api/chat",
    ]);
    expect(received.map((e) => e.type)).toEqual(["error", "fallback"]);
  });
  it("SSE failures retry JSON once, preserve context and never keep partial data", async () => {
    for (const first of [
      new Response("", { status: 500 }),
      response([{ type: "answer_delta", text: "未完成123" }]),
    ]) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              grounded: true,
              known: true,
              answer: "普通接口答案",
            }),
          ),
        );
      vi.stubGlobal("fetch", fetch);
      const result = await streamChat(
        "问题",
        "normal",
        "2017-01-01T14:00:00Z",
        () => {},
        undefined,
        "2026-10-12",
        "14:00",
      );
      expect(result?.text).toBe("普通接口答案");
      expect(fetch.mock.calls.map((c) => c[0])).toEqual([
        "/api/chat/stream",
        "/api/chat",
      ]);
      expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({
        display_date: "2026-10-12",
        display_time: "14:00",
      });
    }
  });
  it("network failures in both transports give only the unavailable message; cancellation never retries", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    expect(
      (await streamChat("问题", "normal", "2017-01-01T14:00:00Z", () => {}))
        ?.text,
    ).toBe("");
    expect(fetch).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    fetch.mockClear();
    expect(
      await streamChat(
        "问题",
        "normal",
        "2017-01-01T14:00:00Z",
        () => {},
        controller.signal,
      ),
    ).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("known=false with needs_human preserves answer plus review flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response([
          { type: "tool_start", tool: "get_forecast", args: {} },
          { type: "answer_delta", text: "不知道" },
          { type: "done", known: false, grounded: true, needs_human: true },
        ]),
      ),
    );
    const result = await streamChat(
      "问题",
      "normal",
      "2017-01-01T14:00:00Z",
      () => {},
    );
    expect(result?.text).toBe("不知道");
    expect(result?.needsHuman).toBe(true);
  });
});

it("JSON fallback preserves session_id and termination metadata", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response("", { status: 404 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answer: "后端时事拒绝话术",
          terminated: true,
          category: "current_affairs",
        }),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const result = await streamChat(
    "问题",
    "normal",
    "2017-01-01T14:00:00Z",
    () => {},
    undefined,
    "2026-10-13",
    "14:00",
    "new-session",
  );
  for (const call of fetch.mock.calls)
    expect(JSON.parse(call[1].body).session_id).toBe("new-session");
  expect(result).toMatchObject({
    text: "后端时事拒绝话术",
    terminated: true,
    category: "current_affairs",
  });
});
