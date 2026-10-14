import { describe, it, expect } from "vitest";
import { blend, nearestHour, constrainTarget } from "../src/core/transitions";

describe("scene transitions and orbit boundary", () => {
  it("converges smoothly with frame-rate independent interpolation", () => {
    expect(blend(0)).toBe(0);
    expect(blend(1 / 60)).toBeGreaterThan(0);
    expect(blend(1 / 60)).toBeLessThan(1);
    expect((1 - blend(1 / 60)) ** 60).toBeCloseTo(1 - blend(1), 10);
  });
  it("takes the shortest circular route at midnight", () => {
    expect(nearestHour(23, 0)).toBe(24);
    expect(nearestHour(0, 23)).toBe(-1);
    expect(nearestHour(24, 1)).toBe(25);
  });
  it("keeps panning within tower radius and above ground", () => {
    const target = constrainTarget({ x: 100, y: -20, z: 100 });
    expect(Math.hypot(target.x, target.z)).toBeCloseTo(24);
    expect(target.y).toBe(0);
    expect(constrainTarget({ x: 2, y: 500, z: 3 })).toEqual({
      x: 2,
      y: 100,
      z: 3,
    });
  });
});
