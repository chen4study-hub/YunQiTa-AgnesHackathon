import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluateOpsSnapshot, type OpsDay } from "../src/data/ops";
import { opsFixtureLoader } from "./ops-page-fixture";
import {
  ELEVATOR_PRESENTATION,
  liftFloorBottom,
} from "../src/pages/floors/elevators";
import {
  floorMetrics,
  floorUseLabel,
  opsFloorScale,
  temperatureColor,
} from "../src/pages/floors/metrics";
import { floorLoadOption } from "../src/pages/floors/FloorLoadChart";
vi.mock("../src/pages/energy/useOpsPage", () => ({
  useOpsPage: () => pageState,
}));
vi.mock("../src/state/context", () => ({
  useDashboard: () => ({
    state: { selectedFloor: 22 },
    store: { selectFloor: vi.fn() },
  }),
}));
import { FloorsPage, TemperatureDisplay } from "../src/pages/FloorsPage";
let day: OpsDay;
let pageState: any;
beforeAll(async () => {
  day = await opsFixtureLoader().loadDay("2026-10-12");
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
describe("ops floors and elevators", () => {
  it("returns exported rows exactly, not an occupancy or temperature model", () => {
    const hour = day.hours[14];
    expect(floorMetrics(hour, 22)).toBe(hour.floors[21]);
    const changed = structuredClone(hour);
    changed.floors[21].floor_actual_kw = 9876.5;
    changed.floors[21].mean_temp_c = 26.2;
    expect(floorMetrics(changed, 22)).toMatchObject({
      floor_actual_kw: 9876.5,
      mean_temp_c: 26.2,
    });
    expect(floorUseLabel("equipment")).toBe("设备层");
  });
  it("plots exported actual loads and a stable office color reference", () => {
    const hour = day.hours[14];
    const scale = opsFloorScale(day);
    const series = (
      floorLoadOption(
        hour.floors.map((f) => f.floor_actual_kw),
        22,
        480,
        scale,
        hour.floors.map((f) => f.use),
      ).series as any[]
    )[0];
    expect(series.data.map((p: any) => p.value)).toEqual(
      hour.floors.map((f) => f.floor_actual_kw),
    );
    expect(series.data[21].itemStyle.borderColor).toBe("#4fd1d9");
    expect(series.data[1].itemStyle.color).toBe("#8597A3");
  });
  it("renders ops values and the same absolute-time elevator snapshot", () => {
    const html = renderToStaticMarkup(<FloorsPage />);
    const row = day.hours[14].floors[21];
    expect(html).toContain(`data-time="14.5"`);
    expect(html).toContain("14:30");
    expect(html).toContain(String(row.zones[0].temp_c.toFixed(1)));
    for (const lift of pageState.snapshot.elevators)
      expect(html).toContain(`data-floor="${lift.floor}"`);
    expect(html).not.toMatch(/派生|回放|模拟/);
  });
  it("missing data renders a retry, never replay metrics or idle fake cars", () => {
    const saved = pageState;
    pageState = { ...saved, day: null, snapshot: null, error: "HTTP 404" };
    const html = renderToStaticMarkup(<FloorsPage />);
    expect(html).toContain("数据暂不可用");
    expect(html).toContain("重试");
    expect(html).not.toContain("floors-lift-car");
    pageState = saved;
  });
  it("uses display mapping only, not locally generated journey schedules", () => {
    expect(liftFloorBottom(1)).toBe("calc(0% - 0 * var(--floors-car-height))");
    expect(liftFloorBottom(40)).toBe(
      "calc(100% - 1 * var(--floors-car-height))",
    );
    expect(Object.values(ELEVATOR_PRESENTATION).map((p) => p.symbol)).toEqual([
      "↑",
      "↓",
      "■",
      "—",
    ]);
    expect(readFileSync("src/pages/floors/elevators.ts", "utf8")).not.toMatch(
      /ROUTES|travelSeconds|elevatorState|Math.sin/,
    );
  });
  it("keeps CSS page-local with floors-prefixed selectors and 12px gaps", () => {
    const css = readFileSync("src/pages/floors/floors.css", "utf8");
    for (const token of [
      ":has",
      ".dashboard",
      ".topbar",
      "nav",
      ".bottombar",
      ".scale-stage",
      ".scale-viewport",
      ".card",
      ".timeline",
      ".page-content",
    ])
      expect(css).not.toContain(token);
    const classes = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(
      (match) => match[1],
    );
    expect(classes.every((name) => name.startsWith("floors-"))).toBe(true);
    expect(
      [
        ...css
          .slice(0, css.indexOf("/* Two-line metric cells"))
          .matchAll(/gap:\s*([^;]+);/g),
      ].every((match) => match[1] === "12px"),
    ).toBe(true);
  });
  it("uses six readable compact-desktop columns while preserving the temperature plot reserve", () => {
    const css = readFileSync("src/pages/floors/floors.css", "utf8");
    const compact = css.slice(
      css.indexOf("@media (min-width: 1201px) and (max-width: 1600px)"),
      css.indexOf("@media (max-width: 1200px)"),
    );
    expect(compact).toContain(
      "grid-template-columns: repeat(6, minmax(0, 1fr))",
    );
    expect(css).toContain("min-height: 200px");
  });
  it("reserves an external label gutter without changing the car floor mapping", () => {
    const css = readFileSync("src/pages/floors/floors.css", "utf8");
    expect(css).toContain("margin: 0.4rem 0 0.4rem calc(3ch + 8px)");
    expect(css).toContain("right: calc(100% + 4px)");
    expect(css).toContain("height: var(--floors-car-height)");
    expect(css).toContain("padding-left: calc(3ch + 8px)");
    expect(css).toContain("margin-inline: 0");
    expect(css).toContain(
      ".floors-lift-column:not(:first-child) .floors-shaft-tick",
    );
  });
  it("centers large temperature values and keeps settings readable", () => {
    const css = readFileSync("src/pages/floors/floors.css", "utf8");
    expect(css).toContain("font-size: var(--font-value-lg)");
    expect(css).toContain(
      "font-size: max(var(--font-label), var(--font-table))",
    );
    expect(css).toContain("font-size: var(--font-unit)");
    expect(css).toContain("justify-content: center");
  });
  it("uses exact temperature thresholds and a 22–28 strip with the 27 degree limit", () => {
    expect(temperatureColor(25.499)).toBe("#2fbf8f");
    expect(temperatureColor(25.5)).toBe("#e5be6a");
    expect(temperatureColor(26.5)).toBe("#e5be6a");
    expect(temperatureColor(26.501)).toBe("#f29252");
    const html = renderToStaticMarkup(
      <TemperatureDisplay value={26.5} label="北区" />,
    );
    expect(html).toContain("色带22至28℃");
    expect(html).toContain("27 上限");
    expect(html).toContain("26.5");
    expect(html).toContain("left:75%");
    expect(html).not.toContain("<svg");
    expect(
      renderToStaticMarkup(<TemperatureDisplay value={30} label="北区" />),
    ).toContain("left:100%");
  });
});
