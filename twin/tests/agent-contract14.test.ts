import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { ReplayData } from "../src/data/types";
import {
  decisionSourceLabel,
  decisionSourceTitle,
  replayDecision,
  scheduleDecision,
  storagePower,
  storageMode,
  signedPower,
} from "../src/pages/agent/data";

const replay = (scenario: string) =>
  JSON.parse(
    readFileSync(`public/replay/${scenario}.json`, "utf8"),
  ) as ReplayData;
it("contract 1.4 keeps selection source separate from explanation provenance for all three days", () => {
  for (const scenario of ["normal", "peak", "abstain"]) {
    const data = replay(scenario);
    for (let i = 0; i < 24; i++) {
      const d = replayDecision(data, i),
        a = data.hours[i].agent;
      const expected = a.source === "llm" ? "LLM 决策" : "规则决策";
      expect(decisionSourceTitle(d)).toBe(
        a.explanation_source === "template"
          ? "模板措辞"
          : a.explanation_source === "llm"
            ? "LLM 措辞"
            : "措辞来源未提供",
      );
      expect(d.selectionSource).toBe(a.source);
      expect(d.explanationSource).toBe(a.explanation_source);
      expect(decisionSourceLabel(d)).toBe(expected);
    }
  }
  expect(decisionSourceLabel(replayDecision(replay("normal"), 14))).toBe(
    "LLM 决策",
  );
});
it("schedule provenance prefers explicit response wording and falls back to the same replay hour only when missing", () => {
  const data = replay("normal"),
    h = data.hours[14];
  const command = {
    timestamp: h.t,
    hvac_setpoint_c: 25.5,
    battery_kw: 0,
    action: "hold",
  };
  const response = {
    building_id: data.meta.building_id,
    plan: [command],
    candidates: [{ candidate_id: "rule_hold", plan: [command] }],
    selected: "rule_hold",
    reason: "接口原文",
  };
  for (const source of ["llm", "rule", "mock"] as const) {
    for (const explanation_source of ["llm", "template"] as const) {
      const d = scheduleDecision(
        { ...response, source, explanation_source },
        data,
        14,
      )!;
      expect(d.source).toBe("schedule");
      expect(d.selectionSource).toBe(source);
      expect(d.explanationSource).toBe(explanation_source);
    }
  }
  expect(decisionSourceLabel(scheduleDecision(response, data, 14)!)).toBe(
    "决策来源未提供",
  );
  for (const scenario of ["normal", "peak"]) {
    const replayData = replay(scenario);
    for (const index of [1, 14]) {
      const h = replayData.hours[index];
      const plan = [{ ...command, timestamp: h.t }];
      const missing = {
        ...response,
        building_id: replayData.meta.building_id,
        source: "llm",
        plan,
        candidates: [{ candidate_id: "rule_hold", plan }],
      };
      const fallback = scheduleDecision(missing, replayData, index)!;
      expect(fallback.explanationSource).toBe(h.agent.explanation_source);
      expect(decisionSourceLabel(fallback)).toBe("LLM 决策");
      expect(decisionSourceTitle(fallback)).toBe(
        h.agent.explanation_source === "llm" ? "LLM 措辞" : "模板措辞",
      );
      const override =
        h.agent.explanation_source === "llm" ? "template" : "llm";
      expect(
        scheduleDecision(
          { ...missing, explanation_source: override },
          replayData,
          index,
        )!.explanationSource,
      ).toBe(override);
      expect(
        scheduleDecision(
          { ...missing, explanation_source: "invalid" },
          replayData,
          index,
        )!.explanationSource,
      ).toBeUndefined();
    }
  }
});
it("plan display names are Chinese even for API machine identifiers", () => {
  const data = replay("normal"),
    h = data.hours[14];
  const plan = [
    { timestamp: h.t, hvac_setpoint_c: 25.5, battery_kw: 0, action: "hold" },
  ];
  for (const name of ["rule_hold", "hold", "保持设定"]) {
    const d = scheduleDecision(
      {
        building_id: data.meta.building_id,
        plan,
        candidates: [{ candidate_id: "rule_hold", name, plan }],
        selected: "rule_hold",
        reason: "接口理由",
      },
      data,
      14,
    )!;
    expect(d.candidates[0].name).toBe("保持设定");
    expect(d.candidates[0].id).toBe("rule_hold");
  }
});
it("storage signs and mode reflect real replay power and current candidate commands", () => {
  expect(storagePower(-381.522)).toBe("充电 381.5 kW");
  expect(storagePower(500)).toBe("放电 500.0 kW");
  expect(storagePower(-0.00001)).toBe("待机 0.0 kW");
  for (const power of [-381.522, 500, -0.00001, 0, 0.00001]) {
    const active = Math.abs(power) >= 0.05;
    const direction = !active ? "待机" : power > 0 ? "放电" : "充电";
    expect(storageMode(power)).toBe(direction);
    expect(storagePower(power)).toBe(
      `${direction} ${(active ? Math.abs(power) : 0).toFixed(1)} kW`,
    );
    expect(signedPower(power)).toBe(
      !active ? "0.0" : `${power > 0 ? "+" : ""}${power.toFixed(1)}`,
    );
  }
  for (const scenario of ["normal", "peak", "abstain"]) {
    const data = replay(scenario);
    for (let i = 0; i < 24; i++) {
      const d = replayDecision(data, i),
        h = data.hours[i];
      expect(d.battery).toBe(
        h.agent.candidate_summaries!.find(
          (c) => c.candidate_id === h.agent.selected,
        )?.battery_kw ?? null,
      );
      for (const c of d.candidates) {
        const summary = h.agent.candidate_summaries!.find(
          (r) => r.candidate_id === c.id,
        )!;
        expect(c.battery).toBe(summary.battery_kw);
        if (Math.abs(c.battery) >= 0.05) {
          expect(signedPower(c.battery)).toMatch(c.battery > 0 ? /^\+/ : /^-/);
          const direction = c.battery > 0 ? "放电" : "充电";
          expect(storageMode(c.battery)).toBe(direction);
          expect(storagePower(c.battery)).toBe(
            `${direction} ${Math.abs(c.battery).toLocaleString("en-US", {
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })} kW`,
          );
        }
      }
    }
  }
});
