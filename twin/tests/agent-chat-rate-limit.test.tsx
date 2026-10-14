import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../src/data/types";
import { replayDecision } from "../src/pages/agent/data";
import { chat } from "../src/pages/agent/api";
import { streamChat } from "../src/pages/agent/chat-stream";
import { AgentChatSession } from "../src/pages/agent/chat-session";
import {
  chatRetrySeconds,
  readChatRateLimit,
} from "../src/pages/agent/chat-rate-limit";
import { ChatRateLimitNotice } from "../src/pages/agent/ChatRateLimitNotice";

const now = Date.parse("2026-10-14T14:00:00Z");
const data = JSON.parse(
  readFileSync("public/replay/normal.json", "utf8"),
) as ReplayData;
const context = {
  data,
  index: 14,
  scenario: "normal",
  nowMs: now,
  decision: replayDecision(data, 14),
  labelOrigin: data.hours[14].t,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function limited(body: unknown, header?: string) {
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      ...(header ? { "Retry-After": header } : {}),
    },
  });
}
const cases = [
  {
    name: "Retry-After takes priority",
    body: { message: "请稍后提问", retry_after_seconds: 99, needs_human: true },
    header: "12",
    wait: 12,
  },
  {
    name: "only JSON seconds",
    body: {
      detail: { message: "提问过于频繁，请等待 7 秒后再试。", wait_seconds: 7 },
    },
    header: undefined,
    wait: 7,
  },
  {
    name: "default 60 seconds",
    body: { message: "提问频繁" },
    header: undefined,
    wait: 60,
  },
];
for (const c of cases) {
  it(`${c.name}: SSE rejection is not a failed answer, never emits fallback/error or retries`, async () => {
    const fetch = vi.fn().mockResolvedValue(limited(c.body, c.header));
    vi.stubGlobal("fetch", fetch);
    const onEvent = vi.fn();
    const result = await streamChat(
      "问题",
      "normal",
      context.decision.t,
      onEvent,
    );
    expect(result).toEqual({
      source: "backend",
      text: "",
      tools: [],
      rateLimit: { retryAt: now + c.wait * 1000 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/chat/stream");
    expect(onEvent).not.toHaveBeenCalled();
  });
  it(`${c.name}: plain /chat also returns independent rate-limit state`, async () => {
    const fetch = vi.fn().mockResolvedValue(limited(c.body, c.header));
    vi.stubGlobal("fetch", fetch);
    const result = await chat("问题", "normal", context.decision.t);
    expect(result?.rateLimit?.retryAt).toBe(now + c.wait * 1000);
    expect(result?.text).toBe("");
    expect(result?.requestError).toBeUndefined();
    expect(result?.needsHuman).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it(`${c.name}: retains draft, counts down, guards sends, survives refresh and permits manual retry at expiry`, async () => {
    let saved = "";
    const storage = {
      getItem: () => saved,
      setItem: (_: string, value: string) => {
        saved = value;
      },
    };
    const fetch = vi.fn().mockResolvedValue(limited(c.body, c.header));
    vi.stubGlobal("fetch", fetch);
    const session = new AgentChatSession(storage);
    const question = " 核对电价和能耗 ";
    session.setDraft(question);
    await session.send(question, context);
    const snapshot = session.getSnapshot(),
      message = snapshot.messages.at(-1)!;
    expect(snapshot).toMatchObject({
      busy: false,
      terminated: false,
      draft: question,
      retryAt: now + c.wait * 1000,
    });
    expect(message).toMatchObject({
      text: "",
      pending: false,
      process: [],
      tools: [],
      requestError: false,
      needsHuman: false,
      terminated: false,
    });
    expect(message.fallback).toBeUndefined();
    expect(
      renderToStaticMarkup(
        <ChatRateLimitNotice retryAt={snapshot.retryAt} now={now} />,
      ),
    ).toContain(`提问太频繁了，请 ${c.wait} 秒后再试`);
    await session.send("不能发送", context);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().messages).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(chatRetrySeconds(snapshot.retryAt)).toBe(c.wait - 1);
    const restored = new AgentChatSession(storage);
    expect(restored.getSnapshot().draft).toBe(question);
    expect(restored.getSnapshot().messages.at(-1)?.rateLimit).toEqual(
      message.rateLimit,
    );
    await restored.send(question, context);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime((c.wait - 1) * 1000);
    expect(chatRetrySeconds(snapshot.retryAt)).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1); // no automatic retry
    expect(
      renderToStaticMarkup(
        <ChatRateLimitNotice retryAt={snapshot.retryAt} now={Date.now()} />,
      ),
    ).toContain("等待已结束，可以再次提问。");
    fetch.mockResolvedValueOnce(
      new Response(
        'data: {"type":"answer_delta","text":"核对完成。"}\n\ndata: {"type":"done","known":true,"grounded":true,"needs_human":false}\n\n',
      ),
    );
    await restored.send(restored.getSnapshot().draft, context);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(restored.getSnapshot().draft).toBe("");
    expect(restored.getSnapshot().messages.at(-1)?.text).toBe("核对完成。");
  });
}
it("handles JSON aliases/detail, invalid headers, fractional seconds, HTTP dates and malformed JSON", async () => {
  for (const [body, header, wait] of [
    [{ retry_after: "4" }, undefined, 4],
    [{ detail: { wait_seconds: 8 } }, undefined, 8],
    [{ retry_after_seconds: 2.1 }, "invalid", 3],
    [{ retry_after_seconds: 5 }, "-1", 5],
    [{ retry_after_seconds: -5 }, undefined, 60],
    [{}, new Date(now + 9000).toUTCString(), 9],
    [{}, "0", 0],
  ] as const) {
    expect((await readChatRateLimit(limited(body, header))).retryAt).toBe(
      now + wait * 1000,
    );
  }
  expect(
    (await readChatRateLimit(new Response("not JSON", { status: 429 })))
      .retryAt,
  ).toBe(now + 60_000);
});
it("a 429 on the ordinary fallback clears partial answer, tool/process errors and never retries again", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('data: {"type":"answer_delta","text":"不完整答案"}\n\n'),
    )
    .mockResolvedValueOnce(limited({ retry_after_seconds: 10 }));
  vi.stubGlobal("fetch", fetch);
  const session = new AgentChatSession();
  await session.send("问题", context);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/chat/stream",
    "/api/chat",
  ]);
  expect(session.getSnapshot()).toMatchObject({
    draft: "问题",
    busy: false,
    terminated: false,
    retryAt: now + 10_000,
  });
  expect(session.getSnapshot().messages.at(-1)).toMatchObject({
    text: "",
    tools: [],
    process: [],
    requestError: false,
    needsHuman: false,
    rateLimit: { retryAt: now + 10_000 },
  });
});
it("new conversation clears history but cannot bypass cooldown; cancellation after reset cannot restore an old question", async () => {
  const fetch = vi.fn().mockResolvedValue(limited({}, "10"));
  vi.stubGlobal("fetch", fetch);
  const session = new AgentChatSession();
  await session.send("问题", context);
  session.reset();
  session.setDraft("新问题");
  expect(session.getSnapshot()).toMatchObject({
    messages: [],
    draft: "新问题",
    retryAt: now + 10_000,
  });
  await session.send("新问题", context);
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(10_000);
  let resolve!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  const pending = session.send("旧问题", context);
  session.reset();
  resolve(limited({}, "60"));
  await pending;
  expect(session.getSnapshot()).toMatchObject({
    messages: [],
    draft: "",
    busy: false,
  });
});
