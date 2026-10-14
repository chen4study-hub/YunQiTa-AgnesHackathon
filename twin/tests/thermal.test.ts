import { beforeAll, describe, it, expect } from "vitest";
import type { OpsDay } from "../src/data/ops";
import { opsFixtureLoader } from "./ops-page-fixture";
import { temperatureAt, comfortMargin } from "../src/pages/floors/thermal";
let day: OpsDay;
beforeAll(async () => {
  day = await opsFixtureLoader().loadDay("2026-10-12");
});
describe("exported zone readings", () => {
  it("reads each exported zone exactly", () => {
    for (const hour of day.hours)
      for (const floor of hour.floors)
        for (const zone of floor.zones)
          expect(temperatureAt(hour, floor.floor, zone.id)).toBe(zone.temp_c);
  });
  it("does not recompute temperatures when loads or setpoints change", () => {
    const hour = structuredClone(day.hours[14]);
    const expected = temperatureAt(hour, 22, "east");
    hour.actual_kw = 100000;
    hour.floors[21].floor_actual_kw = 100000;
    hour.hvac_setpoint_c = 19;
    expect(temperatureAt(hour, 22, "east")).toBe(expected);
    hour.floors[21].zones.find((z) => z.id === "east")!.temp_c = 28.5;
    expect(temperatureAt(hour, 22, "east")).toBe(28.5);
    expect(() => temperatureAt(hour, 22, "missing")).toThrow(
      "Ops zone missing",
    );
  });
  it("only formats differences from the comfort reference", () => {
    expect(comfortMargin(27.3)).toEqual({
      exceeded: true,
      text: "超上限 0.3 ℃",
    });
    expect(comfortMargin(26.8)).toEqual({
      exceeded: false,
      text: "距 27 ℃ 上限 0.2 ℃",
    });
  });
});
