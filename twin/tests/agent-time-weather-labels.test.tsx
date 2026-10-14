import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatProcess } from "../src/pages/agent/ChatProcess";
import type { ChatMessage } from "../src/pages/agent/types";
it("time and weather have Chinese display names while preserving protocol tool identifiers and states", () => {
  const message: ChatMessage = {
    id: 1,
    role: "assistant",
    source: "backend",
    text: "",
    tools: ["get_time", "get_weather"],
    pending: true,
    process: [
      {
        id: 1,
        kind: "tool",
        tool: "get_time",
        text: "",
        state: "done",
        ms: 0.936,
        summary: "时间已查询",
      },
      { id: 2, kind: "tool", tool: "get_weather", text: "", state: "running" },
      { id: 3, kind: "tool", tool: "get_forecast", text: "", state: "error" },
    ],
  };
  const html = renderToStaticMarkup(<ChatProcess message={message} />);
  expect(html).toContain("查询时间");
  expect(html).toContain("查询天气");
  for (const name of message.tools)
    expect(html).toContain(`data-tool="${name}"`);
  expect(html).toContain(`data-tool="get_forecast"`);
  for (const status of ["执行中", "已完成", "未完成"])
    expect(html).toContain(status);
  // Choose milliseconds before rounding; never show a nonzero tool as 0.0 s.
  expect(html).toContain("0.9 ms");
  expect(html).not.toContain("0.0 s");
  expect(message.process?.[0].ms).toBe(0.936);
  expect(message.process?.[1].tool).toBe("get_weather");
});
