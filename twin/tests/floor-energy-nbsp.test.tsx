import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluateOpsSnapshot } from "../src/data/ops";
import { opsFixtureLoader } from "./ops-page-fixture";

let pageState: any;
vi.mock("../src/pages/energy/useOpsPage", () => ({
  useOpsPage: () => pageState,
}));
vi.mock("../src/state/context", () => ({
  useDashboard: () => ({
    state: { selectedFloor: 22, nowMs: pageState.atMs },
    store: { selectFloor: vi.fn() },
  }),
}));
import { EnergyPage } from "../src/pages/EnergyPage";
import { FloorsPage, TemperatureDisplay } from "../src/pages/FloorsPage";
import { PowerOverview } from "../src/pages/energy/PowerOverview";

beforeAll(async () => {
  const day = await opsFixtureLoader().loadDay("2026-10-12");
  const atMs = day.day_start_ms + 14.5 * 3600000;
  pageState = {
    day,
    chartData: day,
    atMs,
    snapshot: evaluateOpsSnapshot(day, atMs),
    loading: false,
    error: null,
    retry: vi.fn(),
  };
});
// Server-rendered text-node concatenation: formatting elements must not be the
// only source of the separator. The browser test checks real DOM textContent.
function readings(html: string) {
  return [...html.matchAll(/<b\b[^>]*>([\s\S]*?)<\/b>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, ""))
    .filter((text) => /(?:kW|kWh|℃|ppm|μg\/m³|m³\/h|元|人|%)$/.test(text));
}
function expectSeparators(texts: string[], minimum: number) {
  expect(texts.length).toBeGreaterThanOrEqual(minimum);
  for (const text of texts) {
    if (text.endsWith("%")) expect(text).toMatch(/(?:\d|—)%$/);
    else
      expect(text).toMatch(
        /(?:\d|—)\u00a0(?:kW|kWh|℃|ppm|μg\/m³|m³\/h|元|人)$/,
      );
  }
}
describe("local floor and energy number/unit text nodes", () => {
  it("energy metrics, cumulative cells and power rows contain real NBSP", () => {
    expectSeparators(readings(renderToStaticMarkup(<EnergyPage />)), 20);
  });
  it("floor metrics contain NBSP except percent", () => {
    expectSeparators(readings(renderToStaticMarkup(<FloorsPage />)), 6);
  });
  it("temperature display separates the styled number and unit in text content", () => {
    const html = renderToStaticMarkup(
      <TemperatureDisplay value={26} label="北区" />,
    );
    expect(html).toContain(
      '<b>26.0</b><small class="type-unit">\u00a0℃</small>',
    );
  });
  it("PowerOverview retains percent with no space and separates each kW reading", () => {
    expectSeparators(
      readings(
        renderToStaticMarkup(
          <PowerOverview data={pageState.day} hour={pageState.snapshot.hour} />,
        ),
      ),
      4,
    );
  });
});
