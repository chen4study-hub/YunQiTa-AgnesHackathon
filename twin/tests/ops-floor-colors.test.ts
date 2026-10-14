import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  opsFloorScale,
  sampleOpsFloorLoads,
  OPS_HOUR_MS,
  type OpsDay,
} from "../src/data/ops";
import { floorScale, floorColor } from "../src/ui/floorColors";
function day(scenario = "normal"): OpsDay {
  const data = JSON.parse(
    readFileSync(`public/replay/${scenario}.ops.json`, "utf8"),
  );
  if (data.meta.floors_file) {
    const sidecar = JSON.parse(
      readFileSync(`public/replay/${data.meta.floors_file}`, "utf8"),
    );
    data.hours.forEach((hour: any, index: number) => {
      hour.floors = sidecar.hours[index].floors;
    });
  }
  return data;
}
it("daily scale uses actual office loads, excludes night and non-office rows, and is cached", () => {
  for (const scenario of ["normal", "peak", "abstain"]) {
    const data = day(scenario);
    const expected = floorScale(
      data.hours
        .slice(8, 21)
        .flatMap((h) =>
          h.floors
            .filter((f) => f.use === "office")
            .map((f) => f.floor_actual_kw),
        ),
    );
    expect(opsFloorScale(data)).toEqual(expected);
    expect(opsFloorScale(data)).toBe(opsFloorScale(data));
    const modified = structuredClone(data);
    for (const [index, hour] of modified.hours.entries())
      for (const floor of hour.floors) {
        floor.floor_kw = 999999;
        if (index < 8 || index > 20 || floor.use !== "office")
          floor.floor_actual_kw = 999999;
      }
    expect(opsFloorScale(modified)).toEqual(expected);
  }
  const scale = opsFloorScale(day());
  expect(scale.p10).toBeCloseTo(21.1, 2);
  expect(scale.p50).toBeCloseTo(27.4, 2);
  expect(scale.p90).toBeCloseTo(34.66, 2);
});
it("continuous floor loads interpolate actual values by floor id and do not jump at hour boundaries", () => {
  const data = day(),
    start = data.day_start_ms;
  const a = data.hours[10].floors,
    b = data.hours[11].floors;
  expect(sampleOpsFloorLoads(data, start + 10 * OPS_HOUR_MS)).toEqual(
    a.map((f) => f.floor_actual_kw),
  );
  const middle = sampleOpsFloorLoads(data, start + 10.5 * OPS_HOUR_MS);
  a.forEach((f, i) =>
    expect(middle[i]).toBeCloseTo(
      (f.floor_actual_kw + b[i].floor_actual_kw) / 2,
      10,
    ),
  );
  expect(middle).not.toEqual(a.map((f) => f.floor_actual_kw));
  const before = sampleOpsFloorLoads(data, start + 11 * OPS_HOUR_MS - 1);
  const after = sampleOpsFloorLoads(data, start + 11 * OPS_HOUR_MS + 1);
  expect(
    Math.max(...before.map((v, i) => Math.abs(v - after[i]))),
  ).toBeLessThan(0.00001);
  expect(sampleOpsFloorLoads(data, start + 23.9 * OPS_HOUR_MS)).toEqual(
    data.hours[23].floors.map((f) => f.floor_actual_kw),
  );
  data.hours[11].floors.reverse();
  expect(sampleOpsFloorLoads(data, start + 10.5 * OPS_HOUR_MS)).toEqual(middle);
  const scale = opsFloorScale(data);
  expect(
    middle.some(
      (load, i) =>
        floorColor(load, scale) !== floorColor(a[i].floor_actual_kw, scale),
    ),
  ).toBe(true);
});
