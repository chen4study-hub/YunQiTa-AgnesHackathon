import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sceneElevators } from "../src/core/elevators";
import { evaluateOpsSnapshot, type OpsDay } from "../src/data/ops";
const day = JSON.parse(
  readFileSync(
    new URL("../../exports/replay/normal.ops.json", import.meta.url),
    "utf8",
  ),
) as OpsDay;
// The scene only needs elevators; use a date-bound absolute anchor.
day.day_start_ms = 1791734400000;
describe("scene uses ops elevator trajectories", () => {
  it("places all six missing-data cars idle at floor 1", () => {
    const states = sceneElevators(null, day.day_start_ms);
    expect(states.map((s) => s.id)).toEqual([
      "L1",
      "L2",
      "L3",
      "H1",
      "H2",
      "H3",
    ]);
    for (const state of states)
      expect(state).toMatchObject({
        floor: 1,
        target: 1,
        status: "idle",
        direction: 0,
        load_pct: 0,
      });
  });
  it("shares the exact public result for absolute instants, including fractional milliseconds", () => {
    const trip = day.elevators[0].trips[0];
    for (const offset of [
      0,
      trip.depart_ms,
      trip.depart_ms + 300.5,
      trip.arrive_ms,
      trip.arrive_ms + trip.dwell_ms,
    ]) {
      const at = day.day_start_ms + offset;
      expect(sceneElevators(day, at)).toEqual(
        evaluateOpsSnapshot(day, at).elevators,
      );
    }
  });
});
