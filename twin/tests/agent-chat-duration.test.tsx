import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../src/data/types";
import type { ChatMessage } from "../src/pages/agent/types";
import { formatChatDuration } from "../src/pages/agent/chat-duration";
import { ChatProcess } from "../src/pages/agent/ChatProcess";
import { eventLine } from "../src/pages/agent/chat-stream";
import { AgentChatSession } from "../src/pages/agent/chat-session";
import { replayDecision } from "../src/pages/agent/data";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
for (const [ms, label] of [
  [35.6, "35.6 ms"],
  [24.5, "24.5 ms"],
  [999.9, "999.9 ms"],
  [1000, "1.0 s"],
  [2300, "2.3 s"],
  [0.01, "<0.1 ms"],
] as const) {
  it(`formats ${ms} ms as ${label} in tool and whole-round displays`, () => {
    expect(formatChatDuration(ms)).toBe(label);
    const message: ChatMessage = {
      id: 1,
      role: "assistant",
      source: "backend",
      text: "",
      tools: [],
      pending: false,
      elapsed: ms,
      process: [
        {
          id: 1,
          kind: "tool",
          tool: "tariff_periods",
          text: "",
          state: "done",
          ms,
        },
      ],
    };
    const html = renderToStaticMarkup(<ChatProcess message={message} />);
    const escaped = label.replace("<", "&lt;");
    expect(html).toContain(`已调用 1 个工具 · ${escaped}`);
    expect(html).toContain(`· ${escaped}</small>`);
    const running = renderToStaticMarkup(
      <ChatProcess message={{ ...message, pending: true }} />,
    );
    expect(running).toContain(`· 已用 ${escaped}`);
  });
}
it("preserves backend milliseconds, leaves missing/invalid timing absent rather than inventing zero", () => {
  expect(
    eventLine(
      JSON.stringify({ type: "tool_end", tool: "tariff_periods", ms: 35.6 }),
    ),
  ).toMatchObject({ ms: 35.6 });
  expect(
    eventLine(
      JSON.stringify({ type: "tool_end", tool: "tariff_periods", ms: 0 }),
    ),
  ).toMatchObject({ ms: 0 });
  for (const ms of [undefined, null, "35.6", -1])
    expect(
      eventLine(
        JSON.stringify({ type: "tool_end", tool: "tariff_periods", ms }),
      ),
    ).toMatchObject({ ms: undefined });
});
it("uses tool_start to tool_end frontend timing when ms is missing, per invocation; backend ms wins and round duration stays unchanged", async () => {
  const data = JSON.parse(
    readFileSync("public/replay/normal.json", "utf8"),
  ) as ReplayData;
  const context = {
    data,
    index: 14,
    scenario: "normal",
    nowMs: Date.parse("2026-10-13T14:00"),
    decision: replayDecision(data, 14),
    labelOrigin: data.hours[14].t,
  };
  let clock = 100;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  let controller: ReadableStreamDefaultController<Uint8Array>;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        }),
      ),
    ),
  );
  const emit = (e: unknown) =>
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`),
    );
  const session = new AgentChatSession();
  const last = () => session.getSnapshot().messages.at(-1)!;
  const sent = session.send("问题", context);
  emit({ type: "tool_start", tool: "storage_history", args: {} });
  await vi.waitFor(() => expect(last().process).toHaveLength(1));
  clock = 124.5;
  emit({ type: "tool_end", tool: "storage_history", summary: "完成" });
  await vi.waitFor(() => expect(last().process?.[0].ms).toBe(24.5));
  clock = 200;
  emit({ type: "tool_start", tool: "storage_history", args: {} });
  await vi.waitFor(() => expect(last().process).toHaveLength(2));
  clock = 251.2;
  emit({ type: "tool_end", tool: "storage_history", summary: "再次完成" });
  await vi.waitFor(() => expect(last().process?.[1].ms).toBeCloseTo(51.2));
  clock = 300;
  emit({ type: "tool_start", tool: "tariff_periods", args: {} });
  await vi.waitFor(() => expect(last().process).toHaveLength(3));
  clock = 800;
  emit({ type: "tool_end", tool: "tariff_periods", ms: 35.6, summary: "完成" });
  await vi.waitFor(() => expect(last().process?.[2].ms).toBe(35.6));
  clock = 2400;
  emit({ type: "done", known: true, grounded: true, needs_human: false });
  await sent;
  expect(last().elapsed).toBe(2300);
  const html = renderToStaticMarkup(<ChatProcess message={last()} />);
  expect(html).toContain("24.5 ms");
  expect(html).toContain("51.2 ms");
  expect(html).toContain("35.6 ms");
  expect(html).toContain("已调用 3 个工具 · 2.3 s");
  expect(html).not.toContain("0.0 s");
});
