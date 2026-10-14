import { afterEach, expect, it, vi } from "vitest";
import * as T from "three";
import { GeometryCache } from "../src/core/geometryCache";
const options = {
  building: {
    floors: 40,
    sqm: 80000,
    twistDeg: 78,
    baseWidth: 6.5,
    topWidth: 4.2,
    taperExponent: 0.8,
    gardenFloors: [14, 27],
  },
  campusCount: 150,
};
function storage() {
  vi.stubGlobal("__BUILD_REVISION__", "test-build");
  vi.stubGlobal("__BUILD_TIME__", "test-time");
  const rows = new Map<string, unknown>();
  const idle: (() => void)[] = [];
  vi.stubGlobal("window", {
    requestIdleCallback: (fn: () => void) => idle.push(fn),
  });
  vi.stubGlobal("indexedDB", {
    open: () => {
      const request: any = {};
      queueMicrotask(() => {
        request.result = {
          close: () => {},
          transaction: () => {
            const tx: any = {};
            tx.objectStore = () => ({
              get: (key: string) => {
                const r: any = {};
                queueMicrotask(() => {
                  r.result = structuredClone(rows.get(key));
                  tx.oncomplete?.();
                });
                return r;
              },
              put: (value: unknown, key: string) => {
                const r: any = {};
                queueMicrotask(() => {
                  rows.set(key, structuredClone(value));
                  tx.oncomplete?.();
                });
                return r;
              },
            });
            return tx;
          },
        };
        request.onsuccess();
      });
      return request;
    },
  });
  return { rows, idle };
}
afterEach(() => vi.unstubAllGlobals());
it("persists merged geometry typed arrays off the startup path and isolates parameters", async () => {
  const { rows, idle } = storage();
  const cache = await GeometryCache.load(options);
  const create = vi.fn(() => new T.BoxGeometry(2, 3, 4).toNonIndexed());
  const a = cache.get("merged", create);
  cache.save();
  expect(rows.size).toBe(0);
  idle.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  expect(rows.size).toBe(1);
  const cached = await GeometryCache.load(options);
  const b = cached.get("merged", create);
  expect(create).toHaveBeenCalledOnce();
  expect(b.getAttribute("position").array).toEqual(
    a.getAttribute("position").array,
  );
  expect(b.getAttribute("normal").array).toEqual(
    a.getAttribute("normal").array,
  );
  expect(b.getAttribute("uv").array).toEqual(a.getAttribute("uv").array);
  b.getAttribute("position").setX(0, 999);
  expect(a.getAttribute("position").getX(0)).not.toBe(999);
  const changed = await GeometryCache.load({
    ...options,
    building: { ...options.building, twistDeg: 79 },
  });
  changed.get("merged", create);
  expect(create).toHaveBeenCalledTimes(2);
  const oldEntry = rows.values().next().value;
  rows.clear();
  rows.set("old-build:old-parameters", oldEntry);
  const invalidated = await GeometryCache.load(options);
  invalidated.get("merged", create);
  expect(create).toHaveBeenCalledTimes(3);
  a.dispose();
  b.dispose();
});
it("storage denied or corrupt typed arrays generate locally", async () => {
  vi.stubGlobal("__BUILD_REVISION__", "test-build");
  vi.stubGlobal("__BUILD_TIME__", "test-time");
  vi.stubGlobal("indexedDB", {
    open: () => {
      throw new Error("denied");
    },
  });
  vi.stubGlobal("window", {});
  const cache = await GeometryCache.load(options);
  const generated = cache.get("merged", () => new T.BoxGeometry());
  expect(generated.getAttribute("position").count).toBeGreaterThan(0);
  const { rows, idle } = storage();
  const valid = await GeometryCache.load(options);
  valid.get("merged", () => new T.BoxGeometry());
  valid.save();
  idle.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  const key = rows.keys().next().value!;
  rows.set(key, {
    merged: {
      attributes: { position: { array: "corrupt", itemSize: 3 } },
      groups: [],
    },
  });
  const working = await GeometryCache.load(options);
  const create = vi.fn(() => new T.BoxGeometry());
  working.get("merged", create);
  expect(create).toHaveBeenCalledOnce();
  generated.dispose();
});
