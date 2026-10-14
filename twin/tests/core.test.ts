import { describe, it, expect, vi } from "vitest";
import { daylight, heatColor, normalize } from "../src/core/palette";
import { Timeline } from "../src/data/timeline";
import {
  MockAdapter,
  ReplayFileAdapter,
  ApiAdapter,
  mockReplay,
} from "../src/data/adapters";
import { validateReplay } from "../src/data/types";
describe("纯函数", () => {
  it("负荷映射边界", () => {
    expect(heatColor(-1)).toBe(0x2fbf8f);
    expect(heatColor(1)).toBe(0xff6a3d);
    expect(normalize(10, 0)).toBe(0);
  });
  it("日夜", () => {
    expect(daylight(0)).toBe(0);
    expect(daylight(12)).toBe(1);
    expect(daylight(20)).toBe(0);
  });
});
describe("时间游标", () => {
  it("播放暂停与销毁", () => {
    vi.useFakeTimers();
    const t = new Timeline(),
      fn = vi.fn();
    t.subscribe(fn);
    t.setHour(23);
    t.play();
    vi.advanceTimersByTime(1000);
    expect(t.hour).toBe(0);
    t.pause();
    vi.advanceTimersByTime(3000);
    expect(t.hour).toBe(0);
    t.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
describe("契约及适配器", () => {
  for (const id of ["normal", "peak", "abstain"])
    it(id, async () => {
      const d = await new MockAdapter().loadScenario(id);
      expect(d.hours).toHaveLength(24);
      d.hours.forEach((h) => {
        expect(h.floors_kw.reduce((a, b) => a + b)).toBeCloseTo(h.point_kw, 1);
        if (h.abstain) expect(h.agent.actions).toEqual([]);
      });
    });
  it("拒绝无效契约", () => {
    const d = mockReplay("normal");
    d.hours.pop();
    expect(() => validateReplay(d)).toThrow();
  });
  it("文件及API响应", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => mockReplay("peak"),
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify(mockReplay("peak"))).buffer,
      })),
    );
    expect(
      (await new ReplayFileAdapter().loadScenario("peak")).meta.scenario,
    ).toBe("peak");
    expect((await new ApiAdapter().loadScenario("peak")).meta.scenario).toBe(
      "peak",
    );
    vi.unstubAllGlobals();
  });
  it("错误响应不伪造数据", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    await expect(
      new ReplayFileAdapter().loadScenario("missing"),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});
