import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ValueCell } from "../src/components/ValueCell";
import { OverviewPage } from "../src/pages/OverviewPage";

const fixture = vi.hoisted(() => ({ data: null as any }));
vi.mock("../src/state/context", () => ({
  useDashboard: () => ({
    state: {
      data: fixture.data,
      time: 14,
      playing: false,
      scenario: "normal",
      playbackStartMs: 1,
    },
    store: {
      getPlaybackFrame: () => ({
        nowMs: Date.parse("2026-10-12T14:00:00+08:00"),
      }),
    },
  }),
}));
vi.mock("../src/data/ops/useOpsDay", () => ({ useOpsDay: () => null }));
vi.mock("../src/components/OverviewScene", () => ({
  OverviewScene: () => null,
}));
vi.mock("../src/components/OverviewVerdict", () => ({
  OverviewVerdict: () => null,
}));
vi.mock("../src/components/ReplayChart", () => ({ ReplayChart: () => null }));
const textContent = (markup: string) => markup.replace(/<[^>]*>/g, "");

it("ValueCell textContent separates values and units with U+00A0, including grouped and negative readings", () => {
  for (const [value, unit] of [
    ["323.7", "kW"],
    ["13,875.9", "kWh"],
    ["21,145.3", "元"],
    ["-12.3", "°C"],
  ]) {
    const html = renderToStaticMarkup(
      <ValueCell label="数值" value={value} unit={unit} />,
    );
    const strong = html.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/)![1];
    expect(textContent(strong)).toBe(`${value}\u00a0${unit}`);
  }
  const bare = renderToStaticMarkup(<ValueCell label="时刻" value="14:00" />);
  expect(textContent(bare)).toBe("时刻14:00");
});

it("all three Overview metric textContent readings include U+00A0 before their unit", () => {
  fixture.data = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
  const html = renderToStaticMarkup(<OverviewPage />);
  const readings = [
    ...html.matchAll(
      /<strong class="type-number overview-number">([\s\S]*?)<\/strong>/g,
    ),
  ];
  expect(readings).toHaveLength(3);
  for (const [index, unit] of ["kW", "kWh", "元"].entries()) {
    expect(textContent(readings[index][1])).toMatch(
      new RegExp(`(?:[\\d,.]+|—)\u00a0${unit}$`),
    );
    expect(textContent(readings[index][1])).not.toMatch(
      new RegExp(`\\d${unit}$`),
    );
  }
});
