import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { apiBase, chat } from "../src/pages/agent/api";
import { replayDecision } from "../src/pages/agent/data";
import { floorOption } from "../src/pages/forecast/charts";
import type { ReplayData } from "../src/data/types";

afterEach(() => vi.unstubAllGlobals());
describe("Agent API and replay presentation", () => {
  it("defaults to same-origin /api and preserves a query override", () => {
    expect(apiBase("")).toBe("/api");
    expect(apiBase("?api=")).toBe("/api");
    expect(apiBase("?api=https%3A%2F%2Fexample.test%2Fapi%2F")).toBe(
      "https://example.test/api",
    );
  });
  it("preserves unknown backend answer and keeps tool trace separate", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        grounded: true,
        known: false,
        needs_human: true,
        answer: "不知道",
        origin: "2017-07-20T14:00:00-05:00",
        tool_trace: [
          { tool: "get_forecast", result: { secret: "not displayed" } },
          { tool: "compare_costs" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetch);
    const answer = await chat(
      "设备故障原因？",
      "peak",
      "2017-07-20T14:00:00-05:00",
    );
    expect(fetch.mock.calls[0][0]).toBe("/api/chat");
    expect(answer?.source).toBe("backend");
    // Backend answer is authoritative; review/tools must not replace its words.
    expect(answer?.text).toBe("不知道");
    expect(answer?.needsHuman).toBe(true);
    expect(answer?.text).not.toContain("secret");
    expect(answer?.tools).toEqual(["get_forecast", "compare_costs"]);
  });
  it("keeps known answers verbatim and handles an empty tool trace", async () => {
    const responses = [
      {
        grounded: true,
        known: true,
        answer: "后端原文 321.4 kW。",
        tool_trace: [],
      },
      { grounded: true, known: false, answer: "不知道", tool_trace: [] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => responses.shift(),
      })),
    );
    expect((await chat("峰值？", "normal", "2017-01-01T14:00:00Z"))?.text).toBe(
      "后端原文 321.4 kW。",
    );
    expect((await chat("未知？", "normal", "2017-01-01T14:00:00Z"))?.text).toBe(
      "不知道",
    );
  });
  it("does not show internal audit summaries as the decision reason", () => {
    const data = JSON.parse(
      readFileSync("public/replay/peak.json", "utf8"),
    ) as ReplayData;
    data.hours[14].agent.selection_reason = {
      ...data.hours[14].agent.selection_reason,
      summary: "旧下发记录保留",
    };
    expect(replayDecision(data, 14).reason).toBe(
      data.hours[14].agent.explanation,
    );
  });
  it("floor loads use zero-origin power axis and load dimension for colors", () => {
    const option = floorOption(Array.from({ length: 40 }, (_, i) => 20 + i));
    expect(option.yAxis).toMatchObject({ min: 0 });
    expect(option.visualMap).toMatchObject({ dimension: 1, min: 0 });
  });
});
