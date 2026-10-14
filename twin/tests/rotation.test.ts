import { it, expect } from "vitest";
import { RotationPolicy } from "../src/core/rotation";
it("resumes rotation after reset transition, but not during it", () => {
  const policy = new RotationPolicy();
  policy.start();
  policy.end(100);
  policy.reset();
  expect(policy.active(200, false, true)).toBe(false);
  expect(policy.active(1200, false, false)).toBe(true);
});
it("pauses throughout dragging and resumes three seconds after release", () => {
  const policy = new RotationPolicy();
  policy.start();
  expect(policy.active(10000, false, false)).toBe(false);
  policy.end(10000);
  expect(policy.active(12999, false, false)).toBe(false);
  expect(policy.active(13000, false, false)).toBe(true);
  expect(policy.active(13000, true, false)).toBe(false);
  policy.enabled = false;
  expect(policy.active(20000, false, false)).toBe(false);
});
