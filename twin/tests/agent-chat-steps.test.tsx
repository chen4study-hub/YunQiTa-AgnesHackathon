import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatProcess } from "../src/pages/agent/ChatProcess";
import { readFileSync } from "node:fs";
it("tools and answer-wait share aligned icon/dot rows, done stays at the same key with seconds", () => {
  const m = {
    id: 1,
    role: "assistant" as const,
    source: "backend" as const,
    text: "",
    tools: [],
    pending: true,
    process: [
      {
        id: 7,
        kind: "tool" as const,
        tool: "web_search",
        text: "",
        state: "running" as const,
      },
      {
        id: 8,
        kind: "tool" as const,
        tool: "current_energy",
        text: "",
        state: "running" as const,
      },
      {
        id: 9,
        kind: "progress" as const,
        text: "正在组织回答，已等待 2 秒",
        progressId: "chat-answer-wait",
      },
    ],
  };
  const html = renderToStaticMarkup(<ChatProcess message={m} />);
  expect(html.match(/class="agent-step-line"/g)).toHaveLength(3);
  expect(html).toContain("联网查询中");
  expect(html).toContain("查询当前能源中");
  expect(html.match(/class="agent-step-dots"/g)).toHaveLength(3);
  expect(html).toContain("<ellipse");
  const completed = renderToStaticMarkup(
    <ChatProcess
      message={{
        ...m,
        pending: false,
        process: [{ ...m.process[0], state: "done", ms: 1600 }],
      }}
    />,
  );
  expect(completed).toContain("✓");
  expect(completed).toContain("1.6");
  expect(completed).not.toContain("data-step-running");
  expect(completed).not.toContain("agent-step-dots");
  const css = readFileSync("src/pages/agent/chat-steps.css", "utf8");
  expect(css).toContain("1.4s ease-in-out infinite");
  expect(css).toContain("prefers-reduced-motion: reduce");
  expect(css).toContain("animation: none");
  expect(css).not.toMatch(/font-size:\s*\d/);
});
