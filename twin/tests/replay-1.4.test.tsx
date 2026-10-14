import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeEol } from "./normalize-eol.mjs";
import { renderToStaticMarkup } from "react-dom/server";
import { validateReplay } from "../src/data/validate";
import { sampleFrame } from "../src/data/interpolate";
import { OverviewVerdict } from "../src/components/OverviewVerdict";
import legacySchema from "../src/data/contracts/replay-1.3.schema.json";
const replay = (name: string) =>
  JSON.parse(readFileSync(`public/replay/${name}.json`, "utf8"));

it("sync-replay keeps each replay and model card identical to exports", () => {
  for (const name of ["normal", "peak", "abstain", "sample", "index"])
    expect(
      normalizeEol(readFileSync(`public/replay/${name}.json`)).equals(
        normalizeEol(readFileSync(`../exports/replay/${name}.json`)),
      ),
    ).toBe(true);
  expect(
    normalizeEol(readFileSync("public/replay/model_card.json")).equals(
      normalizeEol(readFileSync("../exports/model_card.json")),
    ),
  ).toBe(true);
});
it("1.5 requires valid wording provenance and retains actual 1.4/1.3 compatibility", () => {
  const data = replay("normal");
  expect(validateReplay(data).schema_version).toBe("1.5");
  for (const value of ["llm", "template"]) {
    data.hours[0].agent.explanation_source = value;
    expect(validateReplay(data).hours[0].agent.explanation_source).toBe(value);
  }
  data.hours[0].agent.explanation_source = "rule";
  expect(() => validateReplay(data)).toThrow("预测契约不匹配");
  data.hours.forEach((h: any) => delete h.agent.explanation_source);
  expect(() => validateReplay(data)).toThrow("预测契约不匹配");
  // The retained sample is an actual inline 1.4 fixture; do not relabel a
  // split 1.5 file (its forecast payload no longer has legacy HVAC fields).
  const legacy = replay("sample");
  expect(validateReplay(legacy).schema_version).toBe("1.4");
  legacy.hours.forEach((h: any) => delete h.agent.explanation_source);
  expect(validateReplay(legacy).schema_version).toBe("1.4");
  legacy.schema_version = "1.3";
  // Weather and optional wording provenance were introduced in 1.4.
  legacy.hours.forEach((h: any) => {
    delete h.weather;
    delete h.agent.explanation_source;
    h.forecast_24h.forEach((p: any) => delete p.weather);
  });
  legacy.energy_summary.label =
    legacySchema.properties.energy_summary.properties.label.const;
  expect(validateReplay(legacy).schema_version).toBe("1.3");
});
it("peak 14:00 storage regression snapshot matches the export and interpolation preserves agent provenance", () => {
  const data = validateReplay(replay("peak"));
  const frame = sampleFrame(data, 14);
  expect({
    hour: frame.hour.t.slice(11, 16),
    power_kw: Number(frame.hour.storage.power_kw.toFixed(1)),
    soc: Number(frame.hour.storage.soc.toFixed(3)),
  }).toMatchInlineSnapshot(`
   {
     "hour": "14:00",
     "power_kw": 0,
     "soc": 0.95,
   }
 `);
  const exported = JSON.parse(
    readFileSync("../exports/replay/peak.json", "utf8"),
  );
  expect(frame.hour.storage).toEqual(exported.hours[14].storage);
  expect(sampleFrame(data, 14.5).hour.agent.explanation_source).toBe(
    data.hours[14].agent.explanation_source,
  );
});
it("overview distinguishes LLM selection from template wording without inventing LLM selection for rules", () => {
  const data = validateReplay(replay("normal"));
  const hour = structuredClone(data.hours[14]);
  hour.agent.source = "llm";
  hour.agent.explanation_source = "template";
  const render = () =>
    renderToStaticMarkup(
      <OverviewVerdict scenario="normal" hour={hour} time={14} />,
    );
  expect(render()).toContain('title="模板措辞">LLM 决策</span>');
  hour.agent.explanation_source = "llm";
  expect(render()).toContain('title="LLM 措辞">LLM 决策</span>');
  hour.agent.source = "rule";
  hour.agent.explanation_source = "template";
  expect(render()).toContain('title="模板措辞">规则决策</span>');
  expect(render()).not.toContain(">LLM 决策<");
  delete hour.agent.explanation_source;
  expect(render()).not.toContain("模板措辞");
  hour.agent.source = "mock";
  expect(render()).toContain(">规则决策<");
  expect(render()).not.toMatch(/模拟|估算|演示/);
});
it("overview generated handoff IDs use the actual local date, independent of scenario", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 12, 14, 0));
  const data = validateReplay(replay("abstain"));
  const hour = structuredClone(data.hours[14]);
  hour.agent.status = "handoff";
  delete hour.agent.work_orders;
  const render = (time: number) =>
    renderToStaticMarkup(
      <OverviewVerdict scenario="abstain" hour={hour} time={time} />,
    );
  try {
    expect(render(0)).toContain("#2026-1012-01");
    expect(render(14)).toContain("#2026-1012-15");
    expect(render(23)).toContain("#2026-1012-24");
    expect(render(14)).not.toMatch(/2016|2017/);
  } finally {
    vi.useRealTimers();
  }
});
