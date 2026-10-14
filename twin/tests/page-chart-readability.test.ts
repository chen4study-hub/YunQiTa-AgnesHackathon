import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { candidateOption, riskOption } from "../src/pages/agent/charts";
import { replayDecision } from "../src/pages/agent/data";
import type { ReplayData } from "../src/data/types";
import { forecastTheme } from "../src/pages/forecast/Plot";
import { chartTypography } from "../src/pages/forecast/typography";
it("forecast-dark owns its 12px axis/legend/annotation and 13px tooltip floor", () => {
  const theme = forecastTheme();
  expect(theme.textStyle.fontSize).toBe(12);
  for (const axis of [
    "categoryAxis",
    "valueAxis",
    "timeAxis",
    "logAxis",
  ] as const) {
    expect(theme[axis].axisLabel.fontSize).toBe(12);
    expect(theme[axis].nameTextStyle.fontSize).toBe(12);
  }
  expect(theme.legend.textStyle.fontSize).toBe(12);
  expect(theme.tooltip.textStyle.fontSize).toBe(13);
  expect(theme.axisPointer.label.fontSize).toBe(12);
  for (const mark of ["markLine", "markPoint", "markArea"] as const)
    expect(theme[mark].label.fontSize).toBe(12);
});
it("Agent charts cannot override the font floor with hard-coded 11px labels", () => {
  const data = JSON.parse(
    readFileSync("public/replay/normal.json", "utf8"),
  ) as ReplayData;
  const candidate = candidateOption(replayDecision(data, 14)),
    risk = riskOption(data, 14);
  expect(candidate.yAxis).toMatchObject({ axisLabel: { fontSize: 12 } });
  expect(candidate.series).toMatchObject([{ label: { fontSize: 12 } }]);
  for (const o of [candidate, risk]) {
    expect(o.xAxis).toMatchObject({ axisLabel: { fontSize: 12 } });
    expect(o.tooltip).toMatchObject({ textStyle: { fontSize: 13 } });
  }
});

it("chart typography responds to the public CSS tokens rather than local constants", () => {
  const tokens = {
    "--font-label": "16px",
    "--font-legend": "17px",
    "--font-body": "18px",
  };
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (key: string) => tokens[key as keyof typeof tokens] ?? "",
  }));
  try {
    const host = {} as Element,
      fonts = chartTypography(host),
      theme = forecastTheme(host);
    expect(fonts).toEqual({ label: 16, legend: 17, body: 18 });
    expect(theme.legend.textStyle.fontSize).toBe(17);
    expect(theme.tooltip.textStyle.fontSize).toBe(18);
    expect(theme.categoryAxis.axisLabel.fontSize).toBe(16);
  } finally {
    vi.unstubAllGlobals();
  }
});
it("page CSS defines no private size tokens and maps table/body/label/unit to public roles", () => {
  for (const path of [
    "src/pages/agent/readable-layout.css",
    "src/pages/forecast/readable-layout.css",
  ]) {
    const css = readFileSync(path, "utf8");
    expect(css).not.toMatch(
      /--(?:font-[\w-]+|agent-body|agent-label|forecast-body|forecast-label)\s*:/,
    );
    for (const token of [
      "--font-title",
      "--font-body",
      "--font-table",
      "--font-label",
      "--font-unit",
    ])
      expect(css).toContain(`var(${token})`);
  }
});
