import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { LineSeriesOption, BarSeriesOption } from "echarts";
import type { ModelCard, ReplayData, Hour } from "../../data/types";
import { DashboardStore } from "../../state/store";
import { useDashboard } from "../../state/context";
// Shared hook is client-only (no SSR snapshot). Supply store snapshots only in
// this server-markup test; the live browser test exercises its real subscription.
vi.mock("../../state/context", () => ({ useDashboard: vi.fn() }));
import { ForecastPage } from "../ForecastPage";
import { confidenceOption, forecastOption, floorOption } from "./charts";
import {
  forecastView,
  confidenceThresholds,
  mockWindow,
  modelRows,
  number,
  peakPoint,
  rejectedSlots,
  shiftTime,
  timeLabel,
  validWindow,
} from "./data";
import { ForecastContent } from "./ForecastContent";
import type { ForecastWindow } from "./types";
const replay = (scenario = "normal") =>
  JSON.parse(
    readFileSync(`public/replay/${scenario}.json`, "utf8"),
  ) as ReplayData;
const card = JSON.parse(
  readFileSync("public/replay/model_card.json", "utf8"),
) as ModelCard;

describe("forecast contract 1.2 page boundary", () => {
  it("builds exactly 2 observations and 24 future hourly points at midnight and day end", () => {
    for (const hour of [0, 14, 23]) {
      const data = replay();
      const original = JSON.stringify(data);
      const view = mockWindow(data, hour);
      expect(validWindow(view, view.current_t)).toBe(true);
      expect(view.recent_actual.map((p) => p.t)).toEqual([
        shiftTime(view.current_t, -1),
        view.current_t,
      ]);
      expect(view.forecast_24h[0].t).toBe(shiftTime(view.current_t, 1));
      expect(view.forecast_24h[23].t).toBe(shiftTime(view.current_t, 24));
      expect(view.source).toBe("mock");
      expect(JSON.stringify(data)).toBe(original);
    }
    expect(mockWindow(replay(), 0).note).toContain("昨日观测为周期参考值");
    expect(
      mockWindow(replay(), 23).forecast_24h.every(
        (p) => p.t.slice(0, 10) !== replay().hours[23].t.slice(0, 10),
      ),
    ).toBe(true);
  });
  it("preserves timezone and exposes next/previous day labels", () => {
    expect(shiftTime("2026-10-01T23:00:00+08:00", 1)).toBe(
      "2026-10-02T00:00:00+08:00",
    );
    expect(
      timeLabel("2026-10-02T00:00:00+08:00", "2026-10-01T23:00:00+08:00"),
    ).toBe("次日 00:00");
    expect(
      timeLabel("2026-09-30T23:00:00+08:00", "2026-10-01T00:00:00+08:00"),
    ).toBe("昨日 23:00");
  });
  it("prefers a valid backend window; rejects incomplete or inconsistent windows", () => {
    const data = replay();
    const view = mockWindow(data, 14);
    const hour = data.hours[14] as unknown as ForecastWindow;
    Object.assign(hour, {
      forecast_24h: view.forecast_24h,
      recent_actual: view.recent_actual,
    });
    expect(forecastView(data, 14).source).toBe("contract-1.2");
    const malformed = { ...view, forecast_24h: view.forecast_24h.slice(1) };
    expect(validWindow(malformed, view.current_t)).toBe(false);
    hour.forecast_24h = view.forecast_24h.map((p, i) =>
      i === 0 ? { ...p, upper_kw: -1 } : p,
    );
    expect(forecastView(data, 14).source).toBe("mock");
  });
  it("uses real exported 1.2 data unchanged and falls back when both fields are absent", () => {
    const data = JSON.parse(
      readFileSync("../exports/replay/normal.json", "utf8"),
    ) as ReplayData;
    const hour = data.hours[14] as Hour & ForecastWindow;
    const view = forecastView(data, 14);
    expect(view.source).toBe("contract-1.2");
    expect(view.forecast_24h).toBe(hour.forecast_24h);
    expect(view.recent_actual).toBe(hour.recent_actual);
    expect(confidenceThresholds(view)[0]).toBe(
      hour.forecast_24h[0].confidence_threshold,
    );
    const missing = data.hours[14] as unknown as Partial<ForecastWindow>;
    delete missing.forecast_24h;
    delete missing.recent_actual;
    expect(forecastView(data, 14).source).toBe("mock");
  });
  it("builds 24 confidence bars and per-horizon threshold line without invented thresholds", () => {
    const view = mockWindow(replay(), 14);
    const option = confidenceOption(view);
    const series = option.series as (LineSeriesOption | BarSeriesOption)[];
    expect(series[0].data).toHaveLength(24);
    expect(series[1].data).toEqual(
      confidenceThresholds(view).map((v) => (v === null ? null : v * 100)),
    );
    const axis = option.yAxis as { min: number; max: number };
    expect(axis.min).toBeGreaterThan(0);
    expect(axis.min).toBeLessThan(
      Math.min(
        ...view.forecast_24h.map((p) => p.confidence * 100),
        ...confidenceThresholds(view).map((v) => v! * 100),
      ),
    );
    expect(axis.max).toBeGreaterThanOrEqual(
      Math.max(...view.forecast_24h.map((p) => p.confidence * 100)),
    );
    const missing = { ...view, confidence_threshold: undefined };
    expect(confidenceThresholds(missing)).toEqual(Array(24).fill(null));
    expect(
      (confidenceOption(missing).series as LineSeriesOption[])[1].data,
    ).toEqual(Array(24).fill(null));
  });
  it("derives widths, reasons and peak from the full rolling horizon", () => {
    const view = mockWindow(replay("abstain"), 23);
    const rejected = rejectedSlots(view);
    expect(rejected.length).toBe(
      view.forecast_24h.filter((p) => p.abstain).length,
    );
    rejected.forEach((r) => {
      const p = view.forecast_24h.find((p) => p.t === r.t)!;
      expect(r.width_kw).toBe(p.upper_kw - p.lower_kw);
      expect(r.reason).toBeTruthy();
    });
    expect(peakPoint(view).point_kw).toBe(
      Math.max(...view.forecast_24h.map((p) => p.point_kw)),
    );
    expect(
      rejectedSlots({ ...view, reasons: {} }).every((r) =>
        r.reason.includes("暂无数据"),
      ),
    ).toBe(true);
  });
});

describe("forecast rendering and chart semantics", () => {
  it("keeps actuals white and future cyan; interval uses upper-minus-lower; current line stays at t", () => {
    const view = mockWindow(replay("abstain"), 23);
    const series = forecastOption(view).series as LineSeriesOption[];
    expect(series).toHaveLength(4);
    expect(series[0].data?.length).toBe(24);
    expect(series[1].data?.[0]).toEqual([
      view.forecast_24h[0].upper_kw - view.forecast_24h[0].lower_kw,
      1,
    ]);
    expect(series[0].dimensions).toEqual(["load", "offset"]);
    expect(series[1].encode).toEqual({ x: "offset", y: "load" });
    expect(series[2].data).toEqual(
      view.recent_actual.map((p, i) => [i - 1, p.actual_kw]),
    );
    expect(series[2].lineStyle?.color).toBe("#f4f7fb");
    expect(series[2].markLine?.data).toEqual([{ xAxis: 0 }]);
    expect(series[3].lineStyle?.color).toBe("#4fd1d9");
    expect(series[3].data).toHaveLength(25);
    expect(series[3].data?.[0]).toEqual([0, view.recent_actual[1].actual_kw]);
    expect(series[3].data?.[1]).toEqual([1, view.forecast_24h[0].point_kw]);
    expect(series[2].markLine?.label).toMatchObject({
      position: "end",
      rotate: 0,
    });
    expect(forecastOption(view).xAxis).toMatchObject({
      axisLabel: { showMaxLabel: false, hideOverlap: true },
    });
    expect(series[3].markArea?.data?.length).toBe(rejectedSlots(view).length);
  });
  it("renders all 40 zero-baseline bars and treats missing values as gaps", () => {
    const option = floorOption([12, 25]);
    const series = option.series as BarSeriesOption[];
    expect(series[0].data).toHaveLength(40);
    expect(series[0].data?.[2]).toEqual([2, null]);
    expect(option.yAxis).toMatchObject({ min: 0 });
    expect(option.visualMap).toMatchObject({ dimension: 1, min: 0, max: 25 });
  });
  it("formats grouped values; model nulls show no data, including nested fields", () => {
    expect(number(1234.5)).toBe("1,234.5");
    expect(
      modelRows(card).find((r) => r.key === "cross_building_coverage")?.value,
    ).toBe("暂无数据");
    expect(
      modelRows(card).some(
        (r) => r.key === "comparison_apr_dec_pooled.n" && r.value === "6,600",
      ),
    ).toBe(true);
    expect(
      modelRows({ ...card, extra: null }).find((r) => r.key === "extra")?.value,
    ).toBe("暂无数据");
  });
  it("renders no-rejection message, mode last, one-decimal confidence and accessible data", () => {
    const data = replay();
    const view = mockWindow(data, 14);
    const clear = {
      ...view,
      forecast_24h: view.forecast_24h.map((p) => ({ ...p, abstain: false })),
    };
    const html = renderToStaticMarkup(
      <ForecastContent
        view={clear}
        current={data.hours[14]}
        floors={data.hours[14].floors_kw}
        modelCard={card}
        scenario="normal"
        nowMs={new Date(2026, 9, 12, 14).getTime()}
      />,
    );
    expect(html).toContain("未来 24 小时预计均在可信范围内");
    expect(html).toContain("自动调度");
    expect(html).toContain(`${number(data.hours[14].confidence * 100)}%`);
    expect(html).toContain("滚动预测数据表");
    expect(html).toContain("40层负荷数据表");
    expect(html.indexOf("运行模式")).toBeGreaterThan(
      html.indexOf("全样本 MAE"),
    );
    expect(html).not.toContain("评估口径与模型详情");
    expect(html).toContain("模型指标");
    expect(html).not.toMatch(/MOCK|契约 1\.2|待接入|典型日|代表日|情景|高温日/);
    expect(html).not.toContain("周期参考数据");
    expect(html).toContain("2026-10-12");
    expect(html).toContain("未来 24h 置信度评分");
    expect(html).toContain("次日");
  });
  it("reads scenario and current cursor from shared store and preserves loading state", async () => {
    const store = new DashboardStore({
      loadScenario: async (id) => replay(id),
      loadModelCard: async () => card,
      listScenarios: async () => [],
    });
    const render = () => {
      vi.mocked(useDashboard).mockReturnValue({
        store,
        state: store.getSnapshot(),
      });
      return renderToStaticMarkup(<ForecastPage />);
    };
    expect(render()).toContain("数据加载中");
    await store.initialize();
    store.setHour(23);
    expect(render()).toContain(`data-current-t="${replay().hours[23].t}"`);
    await store.loadScenario("abstain");
    expect(render()).toContain(
      `data-current-t="${replay("abstain").hours[23].t}"`,
    );
    store.dispose();
  });
  it("styles only page internals, with mobile stacking and scrollable tables", () => {
    const css = readFileSync("src/pages/forecast/forecast.css", "utf8");
    expect(css).not.toMatch(
      /:has\(|\.scale-viewport|\.scale-stage|\.dashboard|\.topbar|\.bottombar/,
    );
    expect(
      readFileSync("src/pages/forecast/ForecastContent.tsx", "utf8"),
    ).toContain("minmax(0, 1fr)");
    expect(css).not.toMatch(/@media\s*\(max-width/);
    expect(css).toContain("clamp(");
    expect(css).toContain("overflow: auto");
    expect(css).not.toMatch(/height:\s*\d+px/);
  });
});
