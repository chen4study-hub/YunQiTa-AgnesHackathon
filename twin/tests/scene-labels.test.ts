import { expect, it, vi } from "vitest";
import * as T from "three";
import { world } from "../src/core/environment/world";
import {
  intersects,
  layoutSceneLabels,
} from "../src/components/sceneLabelLayout";
it("four coincident anchors are packed without overlapping the tower or each other", () => {
  const tower = { x: 140, y: 90, width: 80, height: 260 };
  const labels = ["tower", "storage", "pv", "grid"].map((key) => ({
    key,
    x: 180,
    y: 300,
    width: 140,
    height: 46,
  }));
  const packed = [...layoutSceneLabels(labels, 360, 520, tower).values()];
  expect(packed).toHaveLength(4);
  packed.forEach((r, i) => {
    expect(intersects(r, tower)).toBe(false);
    packed
      .slice(i + 1)
      .forEach((other) => expect(intersects(r, other)).toBe(false));
  });
});
it("holiday exploded mobile labels pack even when the tower anchor is above the viewport", () => {
  const tower = { x: 131, y: -7, width: 62, height: 256 };
  const labels = [
    { key: "tower", x: 160, y: -18, width: 108, height: 77 },
    { key: "storage", x: 160, y: 280, width: 108, height: 61 },
    { key: "pv", x: 150, y: 290, width: 108, height: 44 },
    { key: "grid", x: 140, y: 270, width: 108, height: 44 },
  ];
  const positions = layoutSceneLabels(labels, 324, 293, tower);
  expect(positions.size).toBe(4);
  const packed = Array.from(positions.values());
  packed.forEach((r, i) => {
    expect(r.x).toBeGreaterThanOrEqual(6);
    expect(r.y).toBeGreaterThanOrEqual(6);
    expect(r.x + r.width).toBeLessThanOrEqual(318);
    expect(r.y + r.height).toBeLessThanOrEqual(287);
    expect(intersects(r, tower, 6)).toBe(false);
    packed
      .slice(i + 1)
      .forEach((other) => expect(intersects(r, other, 6)).toBe(false));
  });
});
it("default-view rays to all PV panel centres are clear of campus blocks", () => {
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: () => {} }),
    }),
  });
  try {
    const env = world(150),
      camera = new T.Vector3(88, 58, 100),
      box = new T.Box3(
        new T.Vector3(-0.5, -0.5, -0.5),
        new T.Vector3(0.5, 0.5, 0.5),
      );
    for (let x = 0; x < 6; x++)
      for (let z = 0; z < 4; z++) {
        const target = new T.Vector3(17 + x * 2.3, 3, 14 + z * 1.7),
          ray = new T.Ray(camera, target.clone().sub(camera).normalize());
        for (let i = 0; i < env.city.count; i++) {
          const matrix = new T.Matrix4();
          env.city.getMatrixAt(i, matrix);
          const local = ray.clone().applyMatrix4(matrix.clone().invert());
          const hit = local.intersectBox(box, new T.Vector3());
          expect(
            hit
              ? hit.applyMatrix4(matrix).distanceTo(camera) <
                  target.distanceTo(camera)
              : false,
            `panel ${x},${z} obstructed by block ${i}`,
          ).toBe(false);
        }
      }
  } finally {
    vi.unstubAllGlobals();
  }
});
