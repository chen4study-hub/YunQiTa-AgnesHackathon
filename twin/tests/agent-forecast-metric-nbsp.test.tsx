import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import type { ReplayData } from "../src/data/types";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
import { replayDecision } from "../src/pages/agent/data";
import { ForecastContent } from "../src/pages/forecast/ForecastContent";
import { forecastView } from "../src/pages/forecast/data";

const data = JSON.parse(
  readFileSync("public/replay/normal.json", "utf8"),
) as ReplayData;
const decision = {
  ...replayDecision(data, 10),
  upper: 420.5,
  temp: 25.6,
  battery: 323.7,
};
const agent = (battery: number | null) =>
  renderToStaticMarkup(
    <div className="agent-root">
      <div className="agent-page">
        <div className="agent-left-slot">
          <DecisionCard
            decision={{ ...decision, battery }}
            data={data}
            index={10}
            pending={false}
            onAction={() => {}}
          />
        </div>
      </div>
    </div>,
  );
const view = forecastView(data, 10);
const forecast = renderToStaticMarkup(
  <ForecastContent
    view={view}
    current={data.hours[10]}
    floors={data.hours[10].floors_kw}
    modelCard={null}
    scenario="normal"
    nowMs={new Date(2026, 9, 12, 10).getTime()}
  />,
);

it.each([323.7, -323.7, 0, null])(
  "PlanNumber puts NBSP in unit text for storage %s",
  (battery) => {
    const html = agent(battery);
    expect(html.match(/<small>\u00a0kW<\/small>/g)).toHaveLength(2);
    expect(html).toContain("<small>\u00a0°C</small>");
    expect(html).not.toContain("margin-left");
  },
);

it("every split forecast Metric unit has a textual NBSP", () => {
  expect(forecast.match(/data-unit="kW">\u00a0kW<\/small>/g)).toHaveLength(5);
  expect(forecast).toContain('data-unit="%">\u00a0%</small>');
});

it("real metric textContent includes NBSP and units stay on the number line without CSS spacing", async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    args: [
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync",
      "--renderer-process-limit=1",
    ],
  });
  try {
    const page = await browser.newPage();
    const css = [
      "src/ui/typography.css",
      "src/pages/agent/agent.css",
      "src/pages/agent/decision-layout.css",
      "src/pages/agent/readable-layout.css",
      "src/pages/forecast/forecast.css",
      "src/pages/forecast/readable-layout.css",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const width of [390, 1280, 1920]) {
      await page.setViewportSize({ width, height: 664 });
      await page.setContent(`<style>${css}
        body { container: dashboard-content / inline-size; }
      </style>${agent(323.7)}${forecast}`);
      expect(
        await page.locator(".agent-plan-number").allTextContents(),
      ).toEqual(["420.5\u00a0kW", "25.6\u00a0°C", "放电 323.7\u00a0kW"]);
      const metrics = page.locator(".forecast-metric dd:has(.forecast-unit)");
      expect(await metrics.count()).toBe(6);
      for (const text of await metrics.allTextContents()) {
        expect(text).toMatch(/\d\u00a0(?:kW|%)$/u);
      }
      // Constrain each value below its intrinsic width: neither flex nor grid may
      // wrap the number/unit pair, including the mobile forecast grid override.
      await page.addStyleTag({
        content:
          ".agent-plan-number, .forecast-metric dd { width: 1px; max-width: 1px; }",
      });
      const measurements = await page
        .locator(".agent-plan-number, .forecast-metric dd:has(.forecast-unit)")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const number = element.querySelector(".smooth-value")!;
            const unit = element.querySelector("small")!;
            const style = getComputedStyle(element);
            const numberBox = number.getBoundingClientRect();
            const text = unit.firstChild as Text;
            const range = document.createRange();
            range.selectNodeContents(text);
            const unitBox = range.getBoundingClientRect();
            return {
              gap: style.columnGap,
              wrap: style.flexWrap,
              whiteSpace: getComputedStyle(unit).whiteSpace,
              unitText: unit.textContent,
              unitLines: range.getClientRects().length,
              overlappingLine:
                unitBox.top < numberBox.bottom &&
                unitBox.bottom > numberBox.top,
            };
          }),
        );
      expect(measurements).toHaveLength(9);
      for (const measurement of measurements) {
        expect(measurement.unitText).toMatch(/^\u00a0(?:kW|°C|%)$/u);
        expect(measurement).toMatchObject({
          gap: "0px",
          wrap: "nowrap",
          whiteSpace: "nowrap",
          unitLines: 1,
          overlappingLine: true,
        });
      }
    }
  } finally {
    await browser.close();
  }
}, 60_000);
