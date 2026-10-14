import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { validateReplay, validateAgentDetail } from "../src/data/validate";
import {
  validateReplay as checkerFor,
  validationErrorsText,
} from "../src/data/validators";
import { loadPreviousDay } from "../src/pages/agent/record-history";
import type { TwinDataSource } from "../src/data/types";
import { mockReplay } from "../src/data/adapters";
const json = (name: string) =>
  JSON.parse(readFileSync(`public/replay/${name}`, "utf8"));
afterEach(() => vi.unstubAllGlobals());
it("selects precompiled checkers for all four versions and formats boolean-checker errors", () => {
  const legacy = json("sample.json");
  legacy.schema_version = "1.3";
  legacy.hours.forEach((h: any) => {
    delete h.weather;
    delete h.agent.explanation_source;
    h.forecast_24h.forEach((p: any) => delete p.weather);
  });
  const schema = JSON.parse(
    readFileSync("src/data/contracts/replay-1.3.schema.json", "utf8"),
  );
  legacy.energy_summary.label =
    schema.properties.energy_summary.properties.label.const;
  for (const input of [
    mockReplay("normal"),
    legacy,
    json("sample.json"),
    json("normal.json"),
  ]) {
    expect(validateReplay(input)).toBe(input);
    const bad = structuredClone(input);
    bad.hours[0].confidence = 2;
    const checker = checkerFor(input.schema_version);
    expect(checker(bad)).toBe(false);
    const text = validationErrorsText(checker.errors);
    expect(() => validateReplay(bad)).toThrow(`预测契约不匹配: ${text}`);
  }
  for (const schema_version of ["1.0", "1.6", {}, null, undefined])
    expect(() => validateReplay({ schema_version })).toThrow("预测契约不匹配");
});
it("keeps hourly order, load sums, forecast horizon/timestamp and observation checks outside schema", () => {
  for (const [patch, error] of [
    [
      (d: any) => {
        d.hours[0].t = d.hours[1].t;
      },
      "小时数据不一致",
    ],
    [
      (d: any) => {
        d.hours[0].floors_kw[0] += 10;
      },
      "小时数据不一致",
    ],
    [
      (d: any) => {
        d.hours[0].forecast_24h[0].t = d.hours[0].t;
      },
      "预测窗口不一致",
    ],
    [
      (d: any) => {
        d.hours[0].forecast_24h[0].horizon = 2;
      },
      "预测窗口不一致",
    ],
    [
      (d: any) => {
        d.hours[0].forecast_24h[0].floors_kw[0] += 10;
      },
      "预测窗口不一致",
    ],
    [
      (d: any) => {
        d.hours[0].recent_actual[0].t = d.hours[0].t;
      },
      "实测窗口不一致",
    ],
  ] as const) {
    const bad = json("normal.json");
    patch(bad);
    expect(checkerFor("1.5")(bad)).toBe(true);
    expect(() => validateReplay(bad)).toThrow(error);
  }
});
it("keeps detail SHA/building/scenario/status/selection/explanation/hour index checks after schema", () => {
  const main = validateReplay(json("normal.json")),
    raw = json("normal.agent-detail.json"),
    sha = createHash("sha256")
      .update(readFileSync("public/replay/normal.json"))
      .digest("hex");
  expect(validateAgentDetail(raw, main, sha)).toBe(raw);
  for (const patch of [
    { main_sha256: "0".repeat(64) },
    { building_id: "wrong" },
    { scenario: "peak" },
  ])
    expect(() => validateAgentDetail({ ...raw, ...patch }, main, sha)).toThrow(
      "与主文件不匹配",
    );
  for (const change of [
    (d: any) => {
      d.hours["14"].t = main.hours[13].t;
    },
    (d: any) => {
      d.hours["14"].agent.explanation = "different";
    },
    (d: any) => {
      d.hours["14"].agent.selected = "other";
    },
    (d: any) => {
      d.hours["14"].agent.status =
        d.hours["14"].agent.status === "handoff" ? "ok" : "handoff";
    },
  ]) {
    const bad = structuredClone(raw);
    change(bad);
    expect(() => validateAgentDetail(bad, main, sha)).toThrow("小时索引不匹配");
  }
});
it("calendar remains authoritative: malformed, duplicate routes and source-date/identity mismatch yield no previous day", async () => {
  const calendar = json("ops-calendar.json"),
    entry = calendar.days.find((d: any) => d.date === "2026-10-11"),
    base = json(`${entry.scenario}.json`),
    source = {
      loadScenario: vi.fn().mockResolvedValue(base),
    } as unknown as TwinDataSource;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(calendar))),
  );
  expect(
    (await loadPreviousDay(source, new Date(2026, 9, 12).getTime(), "/replay"))
      ?.date,
  ).toBe("2026-10-11");
  for (const bad of [
    { ...calendar, days: [...calendar.days, entry] },
    { ...calendar, days: [{ ...entry, scenario: "unknown" }] },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(bad))),
    );
    expect(
      await loadPreviousDay(source, new Date(2026, 9, 12).getTime(), "/replay"),
    ).toBeNull();
  }
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(calendar))),
  );
  for (const meta of [
    { ...base.meta, scenario: "normal" },
    { ...base.meta, date: "2020-01-01" },
  ]) {
    vi.mocked(source.loadScenario).mockResolvedValue({ ...base, meta });
    expect(
      await loadPreviousDay(source, new Date(2026, 9, 12).getTime(), "/replay"),
    ).toBeNull();
  }
});
it("both migrated browser entry points bundle without a runtime schema compiler", async () => {
  for (const entry of [
    "src/data/validate.ts",
    "src/pages/agent/record-history.ts",
  ]) {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2022",
      metafile: true,
      write: false,
      define: { "import.meta.env.BASE_URL": '"/"' },
    });
    const sources = Object.values(result.metafile!.outputs).flatMap((o) =>
      Object.entries(o.inputs)
        .filter(([, v]) => v.bytesInOutput > 0)
        .map(([name]) => name),
    );
    expect(
      sources.some((name) => /node_modules\/(ajv|ajv-formats)\//.test(name)),
    ).toBe(false);
    expect(sources.some((name) => /\.schema\.json$/.test(name))).toBe(false);
    expect(sources.some((name) => name.includes("validators/generated/"))).toBe(
      true,
    );
  }
});
