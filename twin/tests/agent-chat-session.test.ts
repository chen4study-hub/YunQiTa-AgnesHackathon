import { afterEach, it, expect, vi } from "vitest";
import { AgentChatSession } from "../src/pages/agent/chat-session";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../src/data/types";
import { replayDecision } from "../src/pages/agent/data";
const data = JSON.parse(
  readFileSync("public/replay/normal.json", "utf8"),
) as ReplayData;
const context = {
  data,
  index: 14,
  scenario: "normal",
  nowMs: new Date("2026-10-12T14:00").getTime(),
  decision: replayDecision(data, 14),
  labelOrigin: data.hours[14].t,
};
afterEach(() => vi.unstubAllGlobals());
function stream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      }),
    ),
    emit(e: unknown) {
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`),
      );
    },
    close() {
      controller.close();
    },
  };
}
it("owns streaming after all subscribers leave, persists final messages and restores without replay", async () => {
  let stored = "";
  const storage = {
    getItem: () => stored,
    setItem: (_: string, v: string) => {
      stored = v;
    },
  };
  const session = new AgentChatSession(storage),
    s = stream();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(s.response));
  const listener = vi.fn(),
    off = session.subscribe(listener);
  const pending = session.send("问题", context);
  await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(true));
  off();
  s.emit({ type: "answer_delta", text: "第一句。" });
  await vi.waitFor(() =>
    expect(session.getSnapshot().messages.at(-1)?.text).toBe("第一句。"),
  );
  s.emit({ type: "answer_delta", text: "第二句。" });
  s.emit({ type: "done", known: true, grounded: true, needs_human: false });
  s.close();
  await pending;
  expect(session.getSnapshot().messages.at(-1)?.text).toBe("第一句。第二句。");
  expect(session.getSnapshot().busy).toBe(false);
  const restored = new AgentChatSession(storage);
  expect(restored.getSnapshot().messages.at(-1)?.text).toBe("第一句。第二句。");
  expect(restored.getSnapshot().busy).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("new conversation aborts in-flight stream and late chunks cannot repopulate it", async () => {
  const session = new AgentChatSession(),
    s = stream();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_: unknown, o: { signal: AbortSignal }) => {
      signal = o.signal;
      return Promise.resolve(s.response);
    }),
  );
  const pending = session.send("问题", context);
  await vi.waitFor(() => expect(signal).toBeTruthy());
  session.reset();
  expect(signal?.aborted).toBe(true);
  expect(() => s.emit({ type: "answer_delta", text: "迟到答案" })).toThrow();
  await pending;
  expect(session.getSnapshot()).toMatchObject({
    messages: [],
    busy: false,
    terminated: false,
  });
});
it("storage failures/corruption are safe, refreshed pending history is explicitly incomplete", () => {
  const broken = {
    getItem() {
      throw new Error("disabled");
    },
    setItem() {
      throw new Error("quota");
    },
  };
  const session = new AgentChatSession(broken);
  expect(() => session.reset()).not.toThrow();
  expect(
    new AgentChatSession({ getItem: () => "{", setItem() {} }).getSnapshot()
      .messages,
  ).toEqual([]);
  const pending = JSON.stringify({
    version: 1,
    messages: [
      {
        id: 1,
        role: "assistant",
        source: "backend",
        text: "部分答案",
        tools: [],
        pending: true,
      },
    ],
  });
  const restored = new AgentChatSession({
    getItem: () => pending,
    setItem() {},
  });
  expect(restored.getSnapshot().messages[0].pending).toBe(false);
  expect(restored.getSnapshot().messages[0].text).toBe("部分答案");
  expect(restored.getSnapshot().messages[0].requestError).toBe(true);
});

for (const terminal of ["error", "done", "disconnect", "abort"])
  it(`${terminal} releases input state, clears all progress and never lets the old request lock a new one`, async () => {
    const session = new AgentChatSession(),
      s = stream();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(s.response)
        .mockRejectedValue(new Error("offline")),
    );
    const pending = session.send("问题", context);
    await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(true));
    s.emit({ type: "tool_start", tool: "web_search", args: {} });
    for (let i = 0; i < 8; i++)
      s.emit({
        type: "progress",
        id: "chat-answer-wait",
        text: `正在组织回答，已等待 ${i + 1} 秒`,
        elapsed_seconds: i + 1,
      });
    await vi.waitFor(() =>
      expect(
        session
          .getSnapshot()
          .messages.at(-1)
          ?.process?.filter((r) => r.kind === "progress"),
      ).toHaveLength(1),
    );
    if (terminal === "abort") session.cancel();
    else if (terminal === "disconnect") s.close();
    else {
      s.emit(
        terminal === "error"
          ? { type: "error", message: "连接结束" }
          : { type: "done", grounded: true, known: true, needs_human: false },
      );
    }
    await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().messages.at(-1)?.pending).toBe(false);
    expect(
      session
        .getSnapshot()
        .messages.at(-1)
        ?.process?.some((r) => r.kind === "progress" || r.state === "running"),
    ).toBe(false);
    await pending;
    await session.send("下一题", context);
    expect(session.getSnapshot().busy).toBe(false);
  });

it("termination is persisted, guards sends, preserves category/refusal, and reset rotates ID", async () => {
  let saved = "";
  const storage = {
    getItem: () => saved,
    setItem: (_: string, v: string) => (saved = v),
  };
  const session = new AgentChatSession(storage),
    id = session.getSnapshot().sessionId;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  expect(new AgentChatSession(storage).getSnapshot().sessionId).toBe(id);
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      [
        { type: "answer_delta", text: "后端拒绝原文。" },
        {
          type: "done",
          terminated: true,
          category: "politics",
          grounded: true,
          mode: "llm",
        },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join("")
        .replaceAll("\\n", "\n"),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  await session.send("问题", context);
  expect(JSON.parse(fetch.mock.calls[0][1].body).session_id).toBe(id);
  expect(session.getSnapshot().terminated).toBe(true);
  expect(session.getSnapshot().messages.at(-1)).toMatchObject({
    text: "后端拒绝原文。",
    terminated: true,
    category: "politics",
  });
  const restored = new AgentChatSession(storage);
  expect(restored.getSnapshot().terminated).toBe(true);
  await restored.send("追问", context);
  expect(fetch).toHaveBeenCalledTimes(1);
  restored.cancel();
  expect(restored.getSnapshot().terminated).toBe(true);
  restored.reset();
  expect(restored.getSnapshot().terminated).toBe(false);
  expect(restored.getSnapshot().sessionId).not.toBe(id);
  expect(restored.getSnapshot().messages).toEqual([]);
});
