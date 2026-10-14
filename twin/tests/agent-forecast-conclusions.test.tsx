import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import { ForecastContent } from "../src/pages/forecast/ForecastContent";
import { forecastView, modelRows } from "../src/pages/forecast/data";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
import { replayDecision } from "../src/pages/agent/data";
import { displayConclusions } from "../src/pages/displayConclusions";
import { alignAnswer } from "../src/pages/agent/chat-data";
it("operational pages omit method/source panels and use expected conclusions without modifying records", () => {
  const data = JSON.parse(
    readFileSync("public/replay/normal.json", "utf8"),
  ) as ReplayData;
  const card = JSON.parse(
    readFileSync("public/replay/model_card.json", "utf8"),
  );
  const decision = replayDecision(data, 10),
    before = structuredClone(decision);
  const forecast = renderToStaticMarkup(
    <ForecastContent
      view={forecastView(data, 10)}
      current={data.hours[10]}
      floors={data.hours[10].floors_kw}
      modelCard={card}
      scenario="normal"
      nowMs={new Date(2026, 9, 12, 10).getTime()}
    />,
  );
  for (const removed of [
    "非校准概率",
    "评估口径与模型详情",
    "model_card.json",
    "按楼层分配规则计算",
    "forecast-model-details",
    "周期参考数据",
  ])
    expect(forecast).not.toContain(removed);
  expect(forecast).toContain("模型指标");
  expect(forecast).toContain("当前小时 · kW");
  expect(forecast).toContain("预计峰值");
  // 9c3704a synced a809986 migration measurements; keep them outside the local metrics table.
  const metricsTable = forecast.match(
    /aria-label="模型可信度指标表"[^>]*>([\s\S]*?)<\/table>/,
  )?.[1];
  expect(metricsTable).toBeDefined();
  expect(metricsTable).not.toMatch(/92\.7%|迁移评测/);
  expect(metricsTable?.match(/\d+(?:\.\d+)?%/g)).toEqual([
    "90.7%", "90.0%", "15.8%",
  ]);
  expect(forecast).toContain('aria-label="另一栋楼的迁移评测"');
  expect(forecast).toContain("独立迁移评测汇总，不属于本楼指标或验收结果。");
  expect(forecast).toMatch(/<dt>保留样本覆盖率<\/dt><dd>92\.7%<\/dd>/);
  const agent = renderToStaticMarkup(
    <DecisionCard
      decision={decision}
      data={data}
      index={10}
      online={false}
      pending={false}
      onAction={() => {}}
    />,
  );
  expect(agent).not.toMatch(
    /推算|沿用|非实测|演示|候选数字与理由来自调度接口|数字均来自工具计算/,
  );
  expect(agent).toContain("预计电费");
  expect(decision).toEqual(before);
  // Transport failure is state, never a frontend-authored backend answer.
  expect(alignAnswer(null)).toEqual({
    source: "backend", tools: [], text: "", requestError: true,
  });
});
it.each([
  [0, "0.0%"],
  [0.9, "90.0%"],
  [1, "100.0%"],
])("model table and migration evaluation retain one decimal for %s", (value, expected) => {
  const data = JSON.parse(
    readFileSync("public/replay/normal.json", "utf8"),
  ) as ReplayData;
  const forecast = renderToStaticMarkup(
    <ForecastContent
      view={forecastView(data, 10)}
      current={data.hours[10]}
      floors={data.hours[10].floors_kw}
      modelCard={{
        retained_coverage: value,
        target_coverage: 0.905,
        rejection_rate: value,
        cross_building_coverage: value,
      } as any}
      scenario="normal"
      nowMs={new Date(2026, 9, 12, 10).getTime()}
    />,
  );
  const model = forecast.match(
    /aria-label="模型可信度"[\s\S]*?<\/section>/,
  )?.[0];
  expect(model).toBeDefined();
  expect(model?.match(/\d+(?:\.\d+)?%/g)).toEqual([
    expected, "90.0%", expected, expected,
  ]);
});

it("display-only word normalization retains all digits and timestamps", () => {
  const text =
    "沿用 2017-10-23T10:00:00-05:00；推算 1,234.5 kW，线性计算结果非实测；演示数据。";
  const result = displayConclusions(text);
  expect(result).not.toMatch(/推算|沿用|非实测|演示/);
  expect(result).toContain("1,234.5 kW");
  expect(result).toContain("2017-10-23T10:00:00-05:00");
});

it("device connection field is excluded from both direct and nested presentation rows without mutating model data", () => {
  const card = {
      model_version: "test",
      target_coverage: 0.9,
      device_connected: false,
      nested: { device_connected: true, retained_mae: 12.3 },
    } as any,
    before = structuredClone(card);
  const rows = modelRows(card);
  expect(rows.some((r) => r.key.includes("device_connected"))).toBe(false);
  expect(rows.find((r) => r.key === "nested.retained_mae")?.value).toBe(
    "12.3 kW",
  );
  expect(card).toEqual(before);
});

it("model card hides empty metrics, keeps measured values, anonymizes version and separates nominal interval from calibration target", () => {
  const card = JSON.parse(
      readFileSync("public/replay/model_card.json", "utf8"),
    ),
    before = structuredClone(card),
    rows = modelRows(card);
  expect(card.target_coverage).toBe(0.905);
  expect(rows.find((r) => r.key === "model_version")?.value).toBe(
    "负荷预测 v1 · 按楼每日校准",
  );
  expect(rows.find((r) => r.key === "target_coverage")).toMatchObject({
    label: "区间标称覆盖率",
    value: "90.0%",
  });
  expect(rows.find((r) => r.key === "retained_coverage")?.value).toBe("90.7%");
  // 9c3704a changed the data contract: a809986 supplies measured migration coverage, no longer null.
  expect(rows.find((r) => r.key === "cross_building_coverage")).toMatchObject({
    label: "另一栋楼的迁移评测 · 保留样本覆盖率",
    value: "92.7%",
  });
  expect(card).toEqual(before);
  expect(modelRows(null)).toEqual([]);
  const missing = modelRows({
    model_version: "anonymous-v2",
    retained_coverage: null,
    retained_mae: NaN,
    all_sample_mae: undefined,
    rejection_rate: 0,
    target_coverage: 0.9,
    cross_building_coverage: null,
  } as any);
  expect(
    missing.some((r) =>
      [
        "retained_coverage",
        "retained_mae",
        "all_sample_mae",
        "cross_building_coverage",
      ].includes(r.key),
    ),
  ).toBe(false);
  expect(missing.find((r) => r.key === "rejection_rate")?.value).toBe("0.0%");
  expect(missing.find((r) => r.key === "target_coverage")?.value).toBe("90.0%");
});
