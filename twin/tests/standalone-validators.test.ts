import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  validateOps,
  validateOpsCalendar,
  validateReplay,
  validateAgentDetail,
  validationErrorsText,
  type SchemaValidator,
} from "../src/data/validators";
import { mockReplay } from "../src/data/adapters";
import opsSchema from "../../contracts/ops.schema.json";
import calendarSchema from "../src/data/contracts/ops.schema.json";
import replay12 from "../src/data/contracts/replay-1.2.schema.json";
import replay13 from "../src/data/contracts/replay-1.3.schema.json";
import replay14 from "../src/data/contracts/replay-1.4.schema.json";
import replay15 from "../src/data/contracts/replay.schema.json";
import detailSchema from "../src/data/contracts/agent-detail.schema.json";
// Reuse the loader's existing bad SHA, duplicate offset and source mismatch tests.
import "../src/data/ops/ops.test";

const json = (name: string) =>
  JSON.parse(readFileSync(`public/replay/${name}`, "utf8"));
const ajvOps = new Ajv({ allErrors: true, multipleOfPrecision: 8 });
const ajvCalendar = new Ajv({ allErrors: true, strictNumbers: true });
const ajvReplay = new Ajv({
  allErrors: true,
  strictNumbers: true,
  strictTypes: false,
});
[ajvOps, ajvCalendar, ajvReplay].forEach((a) => addFormats(a));
const opsOld = ajvOps.compile(opsSchema),
  calendarOld = ajvCalendar.compile(calendarSchema.oneOf[1]);
const replayOld = [replay12, replay13, replay14, replay15].map((s) =>
  ajvReplay.compile(s),
);
const detailOld = ajvReplay.compile(detailSchema);
function same(
  check: SchemaValidator,
  original: ReturnType<Ajv["compile"]>,
  input: unknown,
) {
  const a = structuredClone(input),
    b = structuredClone(input);
  expect(check(a)).toBe(original(b));
  expect(check.errors).toEqual(original.errors);
  expect(validationErrorsText(check.errors)).toBe(
    ajvOps.errorsText(original.errors),
  );
  expect(a).toEqual(b);
}
it("ops union agrees with runtime Ajv for valid day/calendar/sidecars and malformed data", () => {
  for (const name of [
    "ops-calendar.json",
    "normal.ops.json",
    "peak.ops.json",
    "abstain.ops.json",
    "normal.ops-floors.json",
    "peak.ops-floors.json",
  ]) {
    const data = json(name);
    same(validateOps, opsOld, data);
    expect(validateOps(data)).toBe(true);
    for (const input of [
      null,
      {},
      { ...data, kind: "wrong" },
      { ...data, extra: true },
      { ...data, schema_version: "wrong" },
    ]) {
      same(validateOps, opsOld, input);
      expect(validateOps(input)).toBe(false);
    }
  }
  for (const change of [
    (d: any) => {
      d.hours.pop();
    },
    (d: any) => {
      d.hours[0].offset_ms = 0.1;
    },
    (d: any) => {
      d.hours[0].actual_kw = Infinity;
    },
    (d: any) => {
      d.meta.source_date = "2026-02-30";
    },
  ]) {
    const data = json("normal.ops.json");
    change(data);
    same(validateOps, opsOld, data);
    expect(validateOps(data)).toBe(false);
  }
});
it("calendar-only agrees with record-history checker, including format, enum, and required failures", () => {
  const data = json("ops-calendar.json");
  expect(validateOpsCalendar(data)).toBe(true);
  same(validateOpsCalendar, calendarOld, data);
  for (const change of [
    (d: any) => {
      delete d.days;
    },
    (d: any) => {
      d.days[0].date = "not-a-date";
    },
    (d: any) => {
      d.days[0].scenario = "unknown";
    },
    (d: any) => {
      d.days[0].day_start_ms = "1";
    },
  ]) {
    const bad = structuredClone(data);
    change(bad);
    same(validateOpsCalendar, calendarOld, bad);
    expect(validateOpsCalendar(bad)).toBe(false);
  }
});

it("replay 1.2–1.5 keeps existing bad-data schema outcomes and error detail", () => {
  const fixtures = [
    mockReplay("normal"),
    json("sample.json"),
    json("sample.json"),
    json("normal.json"),
  ];
  const legacy = fixtures[1];
  legacy.schema_version = "1.3";
  legacy.hours.forEach((h: any) => {
    delete h.weather;
    delete h.agent.explanation_source;
    h.forecast_24h.forEach((p: any) => delete p.weather);
  });
  legacy.energy_summary.label =
    replay13.properties.energy_summary.properties.label.const;
  fixtures.forEach((data, index) => {
    const version = ["1.2", "1.3", "1.4", "1.5"][index],
      check = validateReplay(version),
      old = replayOld[index];
    expect(check(data), version).toBe(true);
    same(check, old, data);
    for (const change of [
      (d: any) => {
        d.hours.pop();
      }, // existing core bad-contract case
      (d: any) => {
        d.hours[0].t = "invalid";
      },
      (d: any) => {
        d.hours[0].confidence = 2;
      },
      (d: any) => {
        d.hours[0].point_kw = NaN;
      },
      (d: any) => {
        d.hours[0].floors_kw.pop();
      },
      (d: any) => {
        d.schema_version = "unknown";
      },
    ]) {
      const bad = structuredClone(data);
      change(bad);
      same(check, old, bad);
      expect(check(bad)).toBe(false);
    }
  });
  const wrongWording = json("sample.json");
  wrongWording.hours[0].agent.explanation_source = "rule"; // existing 1.4 bad provenance
  same(validateReplay("1.4"), replayOld[2], wrongWording);
  expect(validateReplay("1.4")(wrongWording)).toBe(false);
  const unknown = validateReplay("__proto__");
  expect(unknown(json("normal.json"))).toBe(false);
  expect(validationErrorsText(unknown.errors)).toContain("supported version");
});
it("agent-detail preserves malformed-schema results; hash/identity/index cross-file checks stay caller-owned", () => {
  for (const sc of ["normal", "peak", "abstain"]) {
    const data = json(`${sc}.agent-detail.json`);
    expect(validateAgentDetail(data)).toBe(true);
    same(validateAgentDetail, detailOld, data);
    for (const patch of [
      { schema_version: "1.4" },
      { main_sha256: "bad" },
      { scenario: "unknown" },
      { building_id: 1 },
      { hours: {} },
      { extra: true },
    ]) {
      const bad = { ...data, ...patch };
      same(validateAgentDetail, detailOld, bad);
      expect(validateAgentDetail(bad)).toBe(false);
    }
    // The existing data-contract15 test rejects these via cross-file checks, not
    // JSON schema. Do not silently change that contract for A's later migration.
    for (const patch of [
      { main_sha256: "0".repeat(64) },
      { building_id: "wrong" },
    ])
      same(validateAgentDetail, detailOld, { ...data, ...patch });
  }
});
