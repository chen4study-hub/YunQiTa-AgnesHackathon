import { afterEach, it, expect, vi } from "vitest";
import {
  eventLine,
  streamChat,
  type ChatStreamEvent,
} from "../src/pages/agent/chat-stream";
afterEach(() => vi.unstubAllGlobals());
it("parses stable progress ids and elapsed seconds, rejecting missing/nonfinite seconds", () => {
  expect(
    eventLine(
      'data: {"type":"progress","id":"chat-answer-wait","text":"正在组织回答，已等待 2 秒","elapsed_seconds":2}',
    ),
  ).toEqual({
    type: "progress",
    id: "chat-answer-wait",
    text: "正在组织回答，已等待 2 秒",
    elapsed_seconds: 2,
  });
  for (const fields of [
    {},
    { id: "chat-answer-wait" },
    { id: "", elapsed_seconds: 2 },
    { id: "x", elapsed_seconds: "2" },
  ])
    expect(
      eventLine(JSON.stringify({ type: "progress", ...fields })),
    ).toBeNull();
});
it("passes repeated id updates and terminal event through without mixing progress into answer", async () => {
  const events = [
    {
      type: "progress",
      id: "chat-answer-wait",
      text: "等待 1 秒",
      elapsed_seconds: 1,
    },
    {
      type: "progress",
      id: "chat-answer-wait",
      text: "等待 2 秒",
      elapsed_seconds: 2,
    },
    { type: "tool_start", tool: "current_energy", args: {} },
    {
      type: "tool_end",
      tool: "current_energy",
      summary: "光伏 20.1 kW",
      ms: 1.2,
    },
    { type: "answer_delta", text: "光伏 20.1 kW。" },
    { type: "done", known: true, grounded: true, needs_human: false },
  ];
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
            c.close();
          },
        }),
      ),
    ),
  );
  const received: ChatStreamEvent[] = [];
  const result = await streamChat(
    "现在光伏发电多少",
    "normal",
    "2017-01-01T14:00:00Z",
    (e) => received.push(e),
  );
  expect(received.map((e) => e.type)).toEqual(events.map((e) => e.type));
  expect(result?.text).toBe("光伏 20.1 kW。");
  expect(result?.tools).toEqual(["current_energy"]);
});
