import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import { replayDecision } from "../src/pages/agent/data";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
import { reasonPreview } from "../src/pages/agent/PlanReason";
it("orders status, equal metrics, Chinese steps/comparison, complete reason and actions without a duplicate plot", () => {
  for (const scenario of ["normal", "peak", "abstain"]) {
    const data = JSON.parse(
      readFileSync(`public/replay/${scenario}.json`, "utf8"),
    ) as ReplayData;
    const d = replayDecision(data, 14),
      html = renderToStaticMarkup(
        <DecisionCard
          data={data}
          decision={d}
          index={14}
          online={false}
          pending={false}
          onAction={() => {}}
        />,
      );
    // Badge follows health (online=false), not replay wording provenance.
    expect(html).toContain("未接 LLM");
    expect(html).not.toContain("LLM 在线");
    expect(html).not.toContain("LLM 预置应答");
    const names = [
      "agent-status-bar",
      'class="agent-plan"',
      "agent-evidence-row",
      "agent-reason-section",
      "agent-actions",
    ];
    const positions = names.map((n) => html.indexOf(n));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const text = html.replace(/<[^>]*>/g, "");
    for (const name of [
      "读取预测",
      "读取环境",
      "生成候选并校验约束",
      "选定方案",
      "核对数字来源",
      "下发 BA/EMS",
      "候选方案对比",
    ])
      expect(text).toContain(name);
    expect(text).not.toContain("get_forecast");
    expect(html).toContain('title="get_forecast"');
    expect(html).not.toContain("agent-decision-plot");
    expect(html).not.toContain("耗时未提供");
    expect(text).not.toContain("等待人工复核");
    if (d.handoff) expect(text).toContain("转交值班人员");
    expect(html).toContain("agent-plan-number");
  }
});
it("reason preview never ends with a partially clamped word and full long reason is retained", () => {
  const text =
    "按24 小时窗口峰值上界准备。选择已通过约束检查的方案。" +
    "后续时段需核对设备状态。".repeat(30);
  expect(reasonPreview(text)).toBe(
    "按24 小时窗口峰值上界准备。选择已通过约束检查的方案。",
  );
  expect(reasonPreview("完整的一句话。")).toBe("完整的一句话。");
  const long = "长句".repeat(80) + "。第二句。";
  expect(reasonPreview(long)).toBe("长句".repeat(80) + "。");
});

it("missing grounding is a provenance statement; real grounding outcomes and handoff remain explicit", () => {
  const data = JSON.parse(
      readFileSync("public/replay/normal.json", "utf8"),
    ) as ReplayData,
    d = replayDecision(data, 14);
  for (const [grounding, label] of [
    [null, "数字取自预测与环境记录"],
    [true, "核对通过"],
    [false, "核对未通过"],
  ] as const) {
    const decision = { ...d, handoff: false, grounding },
      html = renderToStaticMarkup(
        <DecisionCard
          data={data}
          decision={decision}
          index={14}
          online={false}
          pending={false}
          onAction={() => {}}
        />,
      );
    expect(html).toContain(label);
    expect(html).not.toContain("核对结果未提供");
  }
});
it("candidate storage uses direction followed by absolute magnitude without changing signed inputs", () => {
  const data = JSON.parse(
      readFileSync("public/replay/normal.json", "utf8"),
    ) as ReplayData,
    d = replayDecision(data, 14);
  const candidates = [-250, 120, 0, -0.001].map((battery, i) => ({
    ...d.candidates[0],
    id: String(i),
    battery,
  }));
  const decision = { ...d, handoff: false, candidates },
    before = structuredClone(decision);
  const html = renderToStaticMarkup(
    <DecisionCard
      data={data}
      decision={decision}
      index={14}
      online={false}
      pending={false}
      onAction={() => {}}
    />,
  );
  const cells = [
    ...html.matchAll(/<td class="agent-candidate-storage">(.*?)<\/td>/g),
  ].map((m) => m[1].replace(/<[^>]+>/g, ""));
  expect(cells).toEqual(["充电 250.0", "放电 120.0", "待机 0.0", "待机 0.0"]);
  expect(decision).toEqual(before);
});

it("restore status overrides manual lifecycle and failed refresh never announces execution", () => {
  const data = JSON.parse(
    readFileSync("public/replay/normal.json", "utf8"),
  ) as ReplayData;
  const decision = {
    ...replayDecision(data, 14),
    lifecycle: "manual" as const,
  };
  for (const restoration of ["pending", "error"] as const) {
    const html = renderToStaticMarkup(
      <DecisionCard
        data={data}
        decision={decision}
        index={14}
        online
        pending={restoration === "pending"}
        restoration={restoration}
        onAction={() => {}}
      />,
    );
    expect(html).not.toContain("agent-status-reserved");
    expect(html).toContain(`data-restoration="${restoration}"`);
    expect(html).toContain(`aria-busy="${restoration === "pending"}"`);
    expect(html).toContain(
      '<span aria-hidden="true" class="agent-status-hidden">自动方案',
    );
    expect(html).toContain(
      restoration === "pending"
        ? '<span aria-hidden="false" class="">自动调度恢复中…'
        : '<span aria-hidden="false" class="">暂时拿不到最新调度，请稍后刷新',
    );
  }
  const manual = renderToStaticMarkup(
    <DecisionCard
      data={data}
      decision={decision}
      index={14}
      online
      pending={false}
      onAction={() => {}}
    />,
  );
  expect(manual).toContain("agent-status-reserved");
  expect(manual).toContain('role="status" aria-hidden="true"');
});
