import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../src/data/types";
import { AgentChatSession } from "../src/pages/agent/chat-session";
import { replayDecision } from "../src/pages/agent/data";
import { ChatProcess } from "../src/pages/agent/ChatProcess";
import { ChatToolTags } from "../src/pages/agent/ChatToolTags";
import { ChatReply } from "../src/pages/agent/ChatAnswerText";
import { eventLine } from "../src/pages/agent/chat-stream";
import { toolLabel } from "../src/pages/agent/chat-copy";
afterEach(() => vi.unstubAllGlobals());
it("preserves backend names and uses the local table only for absent or blank names", () => {
  expect(
    eventLine(
      JSON.stringify({
        type: "tool_start",
        tool: "tariff_periods",
        name: "分时电价与用电",
        args: {},
      }),
    ),
  ).toMatchObject({ name: "分时电价与用电" });
  expect(toolLabel("current_energy", "楼宇能源数据")).toBe("楼宇能源数据");
  for (const name of [undefined, "", "   "]) {
    expect(toolLabel("current_energy", name)).toBe("查询当前能源");
    expect(toolLabel("unlisted_tool", name)).toBe("运维数据查询");
  }
  const tags = renderToStaticMarkup(
    <ChatToolTags
      tools={["tariff_periods", "current_energy"]}
      toolNames={{ tariff_periods: "分时电价与用电" }}
    />,
  );
  expect(tags).toContain("<code>分时电价与用电</code>");
  expect(tags).toContain("<code>查询当前能源</code>");
  expect(
    renderToStaticMarkup(
      <ChatToolTags
        tools={["tariff_periods"]}
        toolNames={{ tariff_periods: "<img src=x>" }}
      />,
    ),
  ).not.toContain("<img");
});
it("carries names from tool_start through completion, bottom tags and session restoration", async () => {
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
  let saved = "";
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const session = new AgentChatSession(storage);
  const last = () => session.getSnapshot().messages.at(-1)!;
  const emit = (e: unknown) =>
    controller.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`),
    );
  const sent = session.send("查电价", context);
  emit({
    type: "tool_start",
    tool: "tariff_periods",
    name: "分时电价与用电",
    args: {},
  });
  await vi.waitFor(() =>
    expect(last().process?.[0].name).toBe("分时电价与用电"),
  );
  expect(renderToStaticMarkup(<ChatProcess message={last()} />)).toContain(
    "分时电价与用电中",
  );
  emit({ type: "tool_end", tool: "tariff_periods", ms: 35.6, summary: "完成" });
  emit({ type: "answer_delta", text: "电价为1.20 元/kWh。" });
  emit({ type: "done", known: true, grounded: true, needs_human: false });
  await sent;
  expect(last().text).toBe("电价为1.20 元/kWh。");
  expect(renderToStaticMarkup(<ChatProcess message={last()} />)).toContain(
    "分时电价与用电",
  );
  expect(last().process?.[0].name).toBe("分时电价与用电");
  expect(renderToStaticMarkup(<ChatToolTags {...last()} />)).toContain(
    "<code>分时电价与用电</code>",
  );
  const restored = new AgentChatSession(storage).getSnapshot().messages.at(-1)!;
  expect(renderToStaticMarkup(<ChatToolTags {...restored} />)).toContain(
    "<code>分时电价与用电</code>",
  );
});
// 88456e4: rendered numeric/unit separator may be U+0020 or U+00A0 only.
for (const value of [
  "2.0 kW",
  "12.0 kWh",
  "1.20 元/kWh",
  "30.0 元",
  "-2.5 °C",
  "95.0 %",
  "450 ppm",
  "1,200.0 m³/h",
  "35.6 ms",
  "2.3 s",
]) {
  it(`wraps ${value} as one nonbreaking fragment without changing source precision or spacing`, () => {
    const html = renderToStaticMarkup(
      <ChatReply text={`此前保持正常，当前为${value}，下一时段继续检查。`} />,
    );
    expect(html.replace(/\u00a0/g, " ")).toContain(
      `<span class="agent-answer-quantity">${value}</span>`,
    );
    expect(html).toContain("此前保持正常，当前为");
    expect(html).toContain("，下一时段继续检查。");
    expect(html.match(/agent-answer-quantity/g)).toHaveLength(1);
  });
}
it("supports Markdown emphasis, lists, code, streamed unit suffixes, escaping and preserves link URLs", () => {
  const html = renderToStaticMarkup(
    <ChatReply
      text={
        "**1.20 元/kWh**\n\n- `2.0 kW`\n- *450 ppm*\n\n[电价](https://example.com/1.20) <script>alert(1)</script>"
      }
    />,
  );
  expect(html.replace(/\u00a0/g, " ")).toContain(
    '<strong><span class="agent-answer-quantity">1.20 元/kWh</span></strong>',
  );
  expect(html.replace(/\u00a0/g, " ")).toContain(
    '<code><span class="agent-answer-quantity">2.0 kW</span></code>',
  );
  expect(html).toContain('href="https://example.com/1.20"');
  expect(html).not.toContain("<script>");
  expect(
    renderToStaticMarkup(<ChatReply text="电价1.20 元/kWh" pending />).replace(/\u00a0/g, " "),
  ).toContain('<span class="agent-answer-quantity">1.20 元/kWh</span>');
  expect(
    renderToStaticMarkup(
      <ChatReply text="3 seasons、4 kWords、5 msExtra、6 kWh/day" />,
    ),
  ).not.toContain("agent-answer-quantity");
  const css = readFileSync("src/pages/agent/chat-steps.css", "utf8");
  expect(css).toMatch(
    /\.agent-answer-quantity\s*\{[^}]*white-space: nowrap;[^}]*overflow-wrap: normal;[^}]*word-break: normal;/,
  );
});
