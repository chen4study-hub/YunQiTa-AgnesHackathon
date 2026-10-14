import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../../data/types";
import type { BarSeriesOption, LineSeriesOption } from "echarts";
import {
  n,
  elapsedMs,
  object,
  recentHours,
  replayDecision,
  scheduleDecision,
} from "./data";
import { alignAnswer } from "./chat-data";
import { candidateOption, riskOption } from "./charts";
import { DecisionCard } from "./DecisionCard";
import { RecordTable } from "./RecordTable";
import { ChatPanel } from "./ChatPanel";
const replay = (s = "normal") =>
  JSON.parse(readFileSync(`public/replay/${s}.json`, "utf8")) as ReplayData;

describe("deterministic current-hour Agent evidence", () => {
  it("uses only exported summaries and receipt fields", () => {
    const data = replay(),
      h = data.hours[14],
      d = replayDecision(data, 14);
    expect(d.upper).toBe(h.upper_kw);
    expect(d.candidates).toHaveLength(h.agent.candidate_summaries!.length);
    expect(d.candidates[0].cost).toBe(
      h.agent.candidate_summaries![0].energy_cost_cny,
    );
    expect(d.candidates[0].peak).toBe(
      h.agent.candidate_summaries![0].upper_grid_peak_kw,
    );
    expect(d.receipt.count).toBe(h.agent.receipt?.count);
  });
  it("uses recorded candidate figures and audit rationale instead of recomputing stored evidence", () => {
    const data = replay();
    object(data.hours[14].agent).selection_reason = {
      summary: "已记录的选择依据",
      selected_candidate_id: "known",
      current_hour_comparison: {
        candidates: [
          {
            candidate_id: "known",
            hvac_setpoint_c: 25.5,
            battery_kw: 0,
            energy_cost_cny: 876.5,
            upper_grid_peak_kw: 987.6,
            constraint_valid: true,
          },
        ],
      },
    };
    const d = replayDecision(data, 14);
    expect(d.reason).toBe("已记录的选择依据");
    expect(d.selected).toBe("known");
    expect(d.candidates).toHaveLength(1);
    expect(d.candidates[0]).toMatchObject({
      cost: 876.5,
      peak: 987.6,
      peakBasis: "区间上界",
    });
  });
  it("prefers complete exported Agent candidates without appending a baseline", () => {
    const data = replay();
    Object.assign(data.hours[14].agent, {
      selected: "rule_hold",
      explanation: "已导出的完整理由",
      candidates: [
        {
          candidate_id: "rule_hold",
          plan: [
            {
              timestamp: data.hours[14].t,
              hvac_setpoint_c: 25.5,
              battery_kw: 0,
            },
          ],
          simulation: { estimated_cost: 123.4, estimated_peak_kw: 456.7 },
          objective_metrics: { constraint_violations: 0 },
        },
      ],
    });
    const d = replayDecision(data, 14);
    expect(d.candidates).toHaveLength(1);
    expect(d.selected).toBe("rule_hold");
    expect(d.reason).toBe("已导出的完整理由");
    expect(d.candidates[0]).toMatchObject({
      cost: 123.4,
      peak: 456.7,
      passed: true,
    });
  });
  it("handoff never claims a dispatch or extrapolates cost; missing receipt does not invent latency", () => {
    const data = replay("abstain"),
      index = data.hours.findIndex((h) => h.abstain);
    const d = replayDecision(data, index);
    expect(d.handoff).toBe(true);
    expect(d.battery).toBe(0);
    expect(d.receipt.count).toBe(0);
    expect(d.candidates.map((c) => c.cost)).toEqual(
      data.hours[index].agent.candidate_summaries!.map(
        (c) => c.energy_cost_cny,
      ),
    );
    expect(d.ticket.checks).toHaveLength(3);
    const normal = replay();
    delete normal.hours[14].agent.receipt;
    const missing = replayDecision(normal, 14);
    expect(missing.receipt.elapsed).toBeNull();
    expect(missing.receipt.known).toBe(false);
  });
  it("reads authoritative backend candidates and exact reason without adding plans", () => {
    const data = replay(),
      h = data.hours[14];
    const command = {
      timestamp: h.t,
      hvac_setpoint_c: 25.5,
      battery_kw: 0,
      action: "hold",
      prepared_upper_kw: h.upper_kw,
    };
    const response = {
      building_id: data.meta.building_id,
      plan: [command],
      candidates: ["rule_full", "rule_conservative"].map((id) => ({
        candidate_id: id,
        plan: [command],
        simulation: { estimated_cost: 1000, estimated_peak_kw: 1100 },
      })),
      selected: "rule_full",
      reason: "后端选中理由：保留完整原文。",
      explanation: "不应覆盖 reason",
      receipt: {
        count: 2,
        elapsed_ms: 2.123,
        transport: "log_only",
        device_connected: false,
      },
    };
    const d = scheduleDecision(response, data, 14)!;
    expect(d.source).toBe("schedule");
    expect(d.candidates).toHaveLength(2);
    expect(d.candidates[0].cost).toBe(1000);
    expect(d.candidates[0].peak).toBe(1100);
    expect(d.reason).toBe(response.reason);
    expect(d.receipt.elapsed).toBe(2.123);
    expect(d.candidates.every((c) => c.basis === "接口工具")).toBe(true);
    expect(
      scheduleDecision({ ...response, building_id: "wrong" }, data, 14),
    ).toBeNull();
    expect(
      scheduleDecision(
        { ...response, plan: [{ ...command, battery_kw: 900 }] },
        data,
        14,
      ),
    ).toBeNull();
    expect(scheduleDecision({}, data, 14)).toBeNull();
  });
  it("shows fewer rows when yesterday is unavailable, never wraps today's source", () => {
    expect(recentHours(replay(), 14).map((r) => r.index)).toEqual([
      9, 10, 11, 12, 13, 14,
    ]);
    expect(recentHours(replay(), 0)).toHaveLength(1);
  });
  it("preset numbers agree with left card and unknown facts are not guessed", () => {
    const data = replay(),
      d = replayDecision(data, 14);
    expect(alignAnswer(null).text).toBe(
      "这次没能拿到可核验的数据，请稍后再试。",
    );
    expect(
      alignAnswer(
        { text: "电费999999元", tools: [], source: "backend" },
        "为什么这样调度？",
        d,
        data,
        14,
      ).source,
    ).toBe("backend");
    expect(
      alignAnswer(
        {
          text: `按区间上界 ${n(d.upper)} kW 准备`,
          tools: ["get_forecast"],
          source: "backend",
        },
        "为什么这样调度？",
        d,
        data,
        14,
      ).source,
    ).toBe("backend");
  });
});

describe("Agent layout and truthful chart/record rendering", () => {
  it("renders accepted workflow, candidates, receipt actions and independent health badge", () => {
    const data = replay(),
      d = replayDecision(data, 14);
    const html = renderToStaticMarkup(
      <DecisionCard
        decision={d}
        data={data}
        index={14}
        online={false}
        pending={false}
        onAction={() => {}}
      />,
    );
    for (const tool of [
      "get_forecast",
      "get_context",
      "simulate_schedule×3",
      "check_constraints",
      "select_plan",
      "check_grounding",
      "dispatch_to_bms",
    ])
      expect(html).toContain(tool);
    expect(html).toContain("LLM 在线");
    expect(html).not.toContain("LLM 预置应答");
    expect(html).toContain("无需人工确认");
    expect(html).not.toContain("数字均来自工具计算");
    expect(html).toContain("人工接管");
    expect(html).toContain("撤销");
    const table = renderToStaticMarkup(
      <RecordTable
        data={data}
        index={14}
        current={d}
        statuses={{ [d.t]: "工程师微调" }}
      />,
    );
    expect(table).toContain("工程师微调");
    expect(table).not.toContain("15:00");
    const revoked = renderToStaticMarkup(
      <RecordTable
        data={data}
        index={14}
        current={d}
        statuses={{ [d.t]: "已撤销" }}
      />,
    );
    expect(revoked).toContain("已撤销");
  });
  it("renders red handoff, three-column work order and handoff-only actions", () => {
    const data = replay("abstain"),
      index = data.hours.findIndex((h) => h.abstain),
      d = replayDecision(data, index);
    const html = renderToStaticMarkup(
      <DecisionCard
        decision={d}
        data={data}
        index={index}
        online={true}
        pending={false}
        onAction={() => {}}
      />,
    );
    for (const word of [
      "agent-danger",
      "explain_uncertainty",
      "create_handoff_ticket",
      "可能原因",
      "建议检查",
      "保守默认动作",
      "指派给值班工程师",
      "标记已处理",
      "LLM 在线",
    ])
      expect(html).toContain(word);
    expect(html).toContain('aria-hidden="true"');
  });
  it("uses zero-baseline comparison, per-hour risk thresholds, and red above-threshold bars", () => {
    const data = replay("abstain"),
      option = riskOption(data, 10),
      series = option.series as (LineSeriesOption | BarSeriesOption)[];
    expect(series[0].data).toHaveLength(24);
    const future = object(data.hours[10]).forecast_24h;
    const rows = (Array.isArray(future) ? future : data.hours) as {
      risk_score: number;
      risk_threshold: number;
    }[];
    expect(series[1].data).toEqual(rows.map((h) => h.risk_threshold));
    expect(series[1]).toMatchObject({
      lineStyle: { type: "dashed", color: "#f1bd70" },
    });
    rows.forEach((p, i) =>
      expect(
        (series[0].data?.[i] as { itemStyle: { color: string } }).itemStyle
          .color,
      ).toBe(p.risk_score > p.risk_threshold ? "#ff8493" : "#4fd1d9"),
    );
    expect(candidateOption(replayDecision(replay(), 14)).xAxis).toMatchObject({
      min: 0,
    });
    expect(replayDecision(replay(), 14).candidates).toHaveLength(3);
  });
  it("renders a welcome and quick questions without masquerading presets as backend answers", () => {
    const data = replay(),
      html = renderToStaticMarkup(
        <ChatPanel
          data={data}
          index={14}
          scenario="normal"
          nowMs={new Date(2026, 9, 12, 14).getTime()}
          decision={replayDecision(data, 14)}
        />,
      );
    expect(html).toContain("运维对话");
    expect(html).toContain("运维问题");
    expect(html).toContain("选择快捷问题，或直接输入运维问题。");
    expect(html).not.toContain("Agent · 当前方案");
    const css = readFileSync("src/pages/agent/agent.css", "utf8");
    expect(css).not.toMatch(
      /:has\(|\.dashboard|\.scale-stage|\.topbar|\.bottombar/,
    );
    expect(readFileSync("src/pages/AgentPage.tsx", "utf8")).toContain(
      "minmax(0, 1.3fr)",
    );
    expect(css).not.toMatch(/@media\s*\(max-width/);
    expect(css).not.toMatch(/height:\s*\d+px/);
  });
});
