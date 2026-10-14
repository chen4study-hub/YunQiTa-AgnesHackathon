import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import { AgentChatSession } from "../src/pages/agent/chat-session";
import { replayDecision } from "../src/pages/agent/data";
import { ChatProcess } from "../src/pages/agent/ChatProcess";
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
afterEach(() => vi.unstubAllGlobals());
function fixture() {
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
  const session = new AgentChatSession();
  return {
    session,
    emit: (e: unknown) =>
      controller.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`),
      ),
    last: () => session.getSnapshot().messages.at(-1)!,
  };
}
for (const [tool, text] of [
  ["web_search", "正在联网查询…"],
  ["current_energy", "正在查询相关数据…"],
  ["get_weather", "正在查询天气…"],
]) {
  it(`${tool}: clears legacy in-progress step on tool_end and never shows it after done`, async () => {
    const { session, emit, last } = fixture();
    const sent = session.send("问题", context);
    emit({ type: "step", text });
    emit({ type: "tool_start", tool, args: {} });
    await vi.waitFor(() =>
      expect(
        last().process?.find((r) => r.progressId === "chat-tool-wait")?.text,
      ).toBe(text),
    );
    expect(renderToStaticMarkup(<ChatProcess message={last()} />)).toContain(
      text.replace(/…$/, ""),
    );
    emit({ type: "tool_end", tool, ms: 200, summary: "没有查到网上资料" });
    await vi.waitFor(() =>
      expect(
        last().process?.some((r) => r.progressId === "chat-tool-wait"),
      ).toBe(false),
    );
    expect(last().pending).toBe(true);
    emit({ type: "step", text: "已读取工具结果" });
    emit({ type: "step", text: "正在整理回答…" });
    emit({ type: "answer_delta", text: "后端回答原文。" });
    emit({ type: "done", known: true, grounded: true, needs_human: false });
    await sent;
    expect(last().pending).toBe(false);
    expect(last().text).toBe("后端回答原文。");
    const html = renderToStaticMarkup(<ChatProcess message={last()} />);
    expect(html).not.toContain("正在");
    expect(html).not.toContain("data-step-running");
    expect(html).toContain("✓");
    expect(html).toContain("200.0 ms");
    expect(html).toContain("没有查到网上资料");
    expect(html).toContain("已读取工具结果");
  });
}
it("done clears pending narration even without tool_end; missing completion is not falsely marked done", async () => {
  const { session, emit, last } = fixture();
  const sent = session.send("问题", context);
  emit({ type: "step", text: "正在查询相关数据…" });
  emit({ type: "tool_start", tool: "current_energy", args: {} });
  emit({ type: "done", known: false, grounded: false, needs_human: false });
  await sent;
  expect(last().process?.some((r) => r.kind === "progress")).toBe(false);
  expect(last().process?.find((r) => r.kind === "tool")?.state).toBe("error");
  expect(renderToStaticMarkup(<ChatProcess message={last()} />)).not.toMatch(
    /正在|data-step-running/,
  );
});
