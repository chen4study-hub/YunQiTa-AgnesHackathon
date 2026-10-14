import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import { LlmStatusBadge } from "../src/pages/agent/LlmStatusBadge";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
import { ChatPanel } from "../src/pages/agent/ChatPanel";
import { replayDecision } from "../src/pages/agent/data";
import { health } from "../src/pages/agent/api";
const data = JSON.parse(
  readFileSync("public/replay/normal.json", "utf8"),
) as ReplayData;
const decision = replayDecision(data, 14);
const cards = (online: boolean | undefined) => [
  renderToStaticMarkup(
    <ChatPanel
      data={data}
      index={14}
      scenario="normal"
      nowMs={Date.parse(decision.t)}
      decision={decision}
      online={online}
    />,
  ),
  renderToStaticMarkup(
    <DecisionCard
      data={data}
      index={14}
      decision={decision}
      online={online}
      pending={false}
      onAction={() => {}}
    />,
  ),
];
afterEach(() => vi.unstubAllGlobals());
it("non-real health modes display 未接 LLM with inactive styling in both cards", async () => {
  for (const mode of ["mock", "off", undefined]) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ llm: { mode } }))),
    );
    for (const html of cards(await health())) {
      expect(html).toMatch(
        /class="agent-tag agent-llm-badge agent-llm-inactive">未接 LLM<\/span>/,
      );
      expect(html).not.toContain("LLM 在线");
    }
  }
});
it("real health mode displays LLM 在线 in both cards", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ llm: { mode: "real" } })),
      ),
  );
  for (const html of cards(await health())) {
    expect(html).toMatch(/class="agent-tag agent-llm-badge">LLM 在线<\/span>/);
    expect(html).not.toContain("未接 LLM");
  }
});
it("pending health is neutral and never claims online", () => {
  const html = renderToStaticMarkup(<LlmStatusBadge />);
  expect(html).toContain("LLM 检查中");
  expect(html).toContain("agent-llm-inactive");
  expect(html).not.toContain("LLM 在线");
});
it("LLM connectivity does not alter the decision-source label", () => {
  const source = (online: boolean) =>
    cards(online)[1].match(
      /class="agent-decision-source"[^>]*>(.*?)<\/span>/,
    )![1];
  expect(source(false)).toBe(source(true));
});
