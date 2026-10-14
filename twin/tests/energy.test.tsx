import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { evaluateOpsSnapshot, type OpsDay } from "../src/data/ops";
import { opsFixtureLoader } from "./ops-page-fixture";
import {
  energyAlerts,
  endUseRows,
  cumulativeUses,
  environmentAt,
} from "../src/pages/energy/data";
import {
  emsChart,
  environmentChart,
  endUseChart,
} from "../src/pages/energy/charts";
import { PowerOverview, powerRows } from "../src/pages/energy/PowerOverview";
vi.mock("../src/pages/energy/useOpsPage", () => ({
  useOpsPage: () => pageState,
}));
import { EnergyPage } from "../src/pages/EnergyPage";
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
describe("ops energy and events", () => {
  it("uses exact end uses, environment and cumulative export fields", () => {
    const hour = day.hours[14];
    expect(endUseRows(hour).map((r) => r.value)).toEqual([
      hour.end_uses.hvac_electric_estimate_kw,
      hour.end_uses.lighting_kw,
      hour.end_uses.plug_kw,
      hour.end_uses.elevator_kw,
      hour.end_uses.other_kw,
    ]);
    expect(environmentAt(hour)).toBe(hour.environment);
    expect(cumulativeUses(hour.energy.cumulative_start_kwh)[0].energy).toBe(
      hour.energy.cumulative_start_kwh.hvac_electric_estimate_kwh,
    );
    const pie = (endUseChart(hour).series as any[])[0];
    expect(pie.data.map((r: any) => r.value)).toEqual(
      endUseRows(hour).map((r) => r.value),
    );
  });
  it("retains every provided alert/order, excludes future records, preserves IDs", () => {
    const at = day.day_start_ms + 14 * 3600000;
    const expected =
      day.alerts.filter((r) => r.offset_ms <= 14 * 3600000).length +
      day.work_orders.filter((r) => r.offset_ms <= 14 * 3600000).length;
    const rows = energyAlerts(day, at);
    expect(rows).toHaveLength(expected);
    expect(expected).not.toBe(8);
    for (const row of rows) {
      const raw = [...day.alerts, ...day.work_orders].find(
        (r) => r.id === row.id,
      )!;
      expect(row.content).toBe(raw.content);
      expect(row.status).toBe(raw.status);
      expect(row.atMs).toBe(day.day_start_ms + raw.offset_ms);
    }
    const empty = { ...day, alerts: [], work_orders: [] };
    expect(energyAlerts(empty, at)).toEqual([]);
  });
  it("plots 24 source hours without synthesizing a repeated next midnight", () => {
    const now = day.day_start_ms + 14.5 * 3600000;
    const ems = emsChart(day, 14.5, now),
      env = environmentChart(day, 14.5, now);
    const a = (ems.series as any[])[2].data;
    expect(a).toHaveLength(24);
    expect(a[14][1]).toBe(day.hours[14].pv.power_kw);
    const b = (env.series as any[])[1].data;
    expect(b[14][1]).toBe(day.hours[14].environment.co2_ppm);
  });
  it("renders all records, no paging filler or client energy integration", () => {
    const html = renderToStaticMarkup(<EnergyPage />);
    expect((html.match(/data-alert-id=/g) ?? []).length).toBe(
      energyAlerts(day, pageState.atMs).length,
    );
    expect(html).toContain("14:30");
    expect(html).not.toContain("下一页告警");
    const source = readFileSync("src/pages/energy/data.ts", "utf8");
    expect(source).not.toMatch(/Math.sin|integrateDay|share:|deviceEvents/);
  });
  it("renders calendar-window orders across midnight, not only the current day", async () => {
    const loader = opsFixtureLoader();
    const saved = pageState;
    const window = await loader.loadWindow(
      day.day_start_ms + 22 * 3600000,
      day.day_start_ms + 26 * 3600000,
    );
    const next = window.days[1].data;
    const atMs = day.day_start_ms + 25 * 3600000;
    pageState = {
      ...saved,
      day: next,
      chartData: window,
      atMs,
      snapshot: evaluateOpsSnapshot(next, atMs),
    };
    const html = renderToStaticMarkup(<EnergyPage />);
    const expected = window.days
      .flatMap(({ data }) => energyAlerts(data, atMs))
      .filter((row) => row.atMs >= window.start_ms && row.atMs < window.end_ms);
    expect((html.match(/data-alert-id=/g) ?? []).length).toBe(expected.length);
    for (const row of expected)
      expect(html).toContain(`data-alert-id="${row.id}"`);
    pageState = saved;
  });
  it("null storage and grid readings remain missing, never zero telemetry", () => {
    const hour = {
      ...day.hours[14],
      storage: { power_kw: null, soc: null },
      grid_kw: null,
      pv: { power_kw: null },
    };
    expect(
      powerRows(day, hour).every((r) => r.value === null && r.width === null),
    ).toBe(true);
    const html = renderToStaticMarkup(<PowerOverview data={day} hour={hour} />);
    expect(html).toContain("数据暂不可用");
    expect(html).toContain("—");
    expect(html).not.toContain('aria-valuenow="0"');
  });
  it("loading failure exposes retry without stale metrics", () => {
    const saved = pageState;
    pageState = { ...saved, day: null, snapshot: null, error: "404" };
    const html = renderToStaticMarkup(<EnergyPage />);
    expect(html).toContain("数据暂不可用");
    expect(html).toContain("重试");
    expect(html).not.toContain("energy-number");
    pageState = saved;
  });
  it("balances the desktop upper cards and alert table without page scrolling", () => {
    // CSS line endings are whitespace, not the byte-exact artifact contract.
    const css = readFileSync("src/pages/energy/energy.css", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(css).toContain(
      "grid-template-rows: minmax(0, 1.15fr) minmax(0, 1fr)",
    );
    const compact = css.slice(
      css.indexOf("/* Compact desktop reserves plot height"),
      css.indexOf("@media (max-width: 1600px)"),
    );
    expect(compact).toContain(
      "grid-template-rows: minmax(0, 1.7fr) minmax(0, 1fr)",
    );
    expect(css).toContain("height: min(100%, 200px)");
    expect(css).toContain("max-width: 200px");
  });
  it("styles only energy-prefixed page classes plus defined public typography classes, never shell classes", () => {
    // CSS line endings are whitespace, not the byte-exact artifact contract.
    const css = readFileSync("src/pages/energy/energy.css", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const typography = readFileSync("src/ui/typography.css", "utf8");
    const publicTypography = new Set(
      [...typography.matchAll(/\.(type-[\w-]+)/g)].map((match) => match[1]),
    );
    expect(publicTypography.has("type-unit")).toBe(true);
    const unauthorized = [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)]
      .map((match) => match[1])
      .filter(
        (name) => !name.startsWith("energy-") && !publicTypography.has(name),
      );
    expect(unauthorized).toEqual([]);
    for (const token of [
      ":has",
      ".card",
      ".dashboard",
      ".topbar",
      ".bottombar",
      ".scale-stage",
      ".page-content",
    ])
      expect(css).not.toContain(token);
    // Allow only the requested EMS label/value micro-spacing exception.
    const totals =
      ".energy-page .energy-ems-totals > div {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}";
    expect(css).toContain(totals);
    expect(
      [
        ...css
          .slice(0, css.indexOf("/* Left-aligned value/unit pairs"))
          .replace(totals, "")
          .matchAll(/gap:\s*([^;]+);/g),
      ].every((match) => match[1] === "12px"),
    ).toBe(true);
  });
});
