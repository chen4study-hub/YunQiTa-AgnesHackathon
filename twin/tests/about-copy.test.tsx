import { it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { About } from "../src/components/About";
import {
  OverviewVerdict,
  formatOverviewAction,
} from "../src/components/OverviewVerdict";
import type { ModelCard } from "../src/data/types";
import { mockReplay } from "../src/data/adapters";
import type { LiveSchedule } from "../src/data/liveSchedule";

const state = vi.hoisted(() => ({
  modelCard: null as ModelCard | null,
  data: null,
}));
vi.mock("../src/state/context", () => ({ useDashboard: () => ({ state }) }));
it("About metrics respond to model-card state, independently of the fixed reliability paragraph", () => {
  const render = (card: ModelCard) => {
    state.modelCard = card;
    return renderToStaticMarkup(<About />);
  };
  const card = {
    model_version: "byron-expanded-holiday-monthly-v1",
    retained_coverage: 0.731,
    target_coverage: 0.85,
    rejection_rate: 0.123,
    retained_mae: 51.2,
    all_sample_mae: 62.3,
    cross_building_coverage: 0.789,
  };
  const metrics = (html: string) =>
    html.split('class="about-metrics"')[1].split("<figure")[0];
  const html = render(card),
    values = metrics(html);
  for (const value of ["73.1%", "90%", "12.3%", "51.2 kW", "62.3 kW"])
    expect(values).toContain(value);
  expect(html).toContain("负荷预测 v1 · 按楼每日校准");
  expect(html).toContain("区间标称覆盖率");
  // Source correspondence now names the measured building; metric labels and
  // anonymized model version must still not expose the input model identifier.
  expect(values).not.toMatch(/byron|目标覆盖率|跨建筑覆盖率|85.0%|78.9%/i);
  expect(html).not.toContain(card.model_version);
  expect(html).toContain("BDG2 Byron 楼 2017 年逐时实测");
  expect(metrics(render({ ...card, retained_coverage: 0.647 }))).toContain(
    "64.7%",
  );
  expect(html).toContain(
    "预测可靠性按本楼前 10 天的误差每日更新，只用当天之前的数据。全年保留覆盖率由 90.4% 升至 90.7%，拒绝率由 16.2% 降至 15.8%。数据突变时仍需转人工；对低风险楼宇启用后，拒绝可能增多。",
  );
  expect(html).toContain(
    "候选方案的费用只比较可自动调度的时段，转人工时段不计入。",
  );
  expect(html).toContain("约束检查后记录日志回执；当前部署未接入现场设备。");
});
it("overview footer reports receipts/handoff without equipment disclosure or claiming missing receipts", () => {
  const hour = mockReplay("normal").hours[14];
  const footer = (decision?: LiveSchedule) => {
    const html = renderToStaticMarkup(
      <OverviewVerdict
        scenario="normal"
        hour={hour}
        time={14}
        liveDecision={decision}
      />,
    );
    // The fixed footer is outside the scroll shell and has multiple class tokens.
    const match = html.match(
      /<div\b[^>]*class="[^"]*\boverview-verdict-footer\b[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    );
    expect(match, "the current conclusion-card footer must exist").not.toBeNull();
    const text = match![1].replace(/<[^>]*>/g, "").trim();
    expect(text).not.toBe("");
    expect(text).not.toMatch(
      /设备|日志回执正常|整点决策|数值连续插值|实时结果/,
    );
    return text;
  };
  expect(footer()).not.toMatch(
    /设备|日志回执正常|整点决策|数值连续插值|实时结果/,
  );
  expect(formatOverviewAction("BA设定温度 25.8 °C")).toBe(
    "BA 设定温度 25.8 °C",
  );
  expect(formatOverviewAction("EMS储能功率 0.0 kW")).toBe(
    "EMS 储能功率 0.0 kW",
  );
  expect(formatOverviewAction("BA 设定温度")).toBe("BA 设定温度");
  const spacedHour = {
    ...hour,
    agent: {
      ...hour.agent,
      status: "executed" as const,
      actions: ["BA设定温度 25.8 °C", "EMS储能功率 0.0 kW"],
    },
  };
  const spacedHtml = renderToStaticMarkup(
    <OverviewVerdict scenario="normal" hour={spacedHour} time={14} />,
  );
  expect(spacedHtml).toContain("BA 设定温度");
  expect(spacedHtml).toContain("EMS 储能功率");
  const decision: LiveSchedule = {
    t: hour.t,
    handoff: false,
    upper: 1300,
    confidence: 0.9,
    threshold: 0.8,
    temp: 26,
    battery: 0,
    reason: "已记录",
    candidates: [],
    selected: "auto",
    source: "schedule",
    receipt: {
      count: 1,
      elapsed: 1,
      transport: "log",
      connected: false,
      known: true,
    },
    ticket: {
      id: "ticket",
      reasons: [],
      checks: [],
      temp: null,
      battery: null,
    },
    grounding: true,
  };
  expect(footer(decision)).toContain("整点调度 · 回执已记录");
  expect(
    footer({ ...decision, receipt: { ...decision.receipt, count: 0 } }),
  ).toContain("整点调度 · 暂无回执记录");
  expect(footer({ ...decision, handoff: true })).toContain(
    "整点调度 · 已转人工",
  );
});
