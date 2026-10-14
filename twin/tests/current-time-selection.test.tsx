import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardStore } from "../src/state/store";
import { MockAdapter } from "../src/data/adapters";
import { BottomBar } from "../src/components/BottomBar";
import { stubRaf } from "./raf-test-helper";

let store: DashboardStore;
// Static markup exercises button visibility; live subscriptions are covered in browser tests.
vi.mock("../src/state/context", () => ({
  useDashboard: () => ({ state: store.getSnapshot(), store }),
}));
beforeEach(async () => {
  stubRaf();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 12, 13, 59, 58));
  store = new DashboardStore(new MockAdapter(), undefined, { query: "" });
  await store.initialize();
});
afterEach(() => {
  store.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const footer = () => renderToStaticMarkup(<BottomBar />);

it("pins the displayed selected time beyond three seconds while the real clock advances", () => {
  store.setHour(5);
  const now = store.getSnapshot().nowMs;
  const realNow = store.getRealNowMs();
  vi.advanceTimersByTime(4000);
  expect(store.getSnapshot()).toMatchObject({
    hour: 5,
    time: 5,
    followingCurrent: false,
    nowMs: now,
  });
  expect(store.getRealNowMs()).toBe(realNow + 4000);
  expect(store.getPlaybackFrame().nowMs).toBe(now);
  expect(store.getPlaybackFrame().time).toBe(5);
  expect(store.getContinuousTime()).toBe(5);
  expect(store.getPlaybackFrame().nowMs).toBe(
    new Date(2026, 9, 12, 5).getTime(),
  );
  expect(footer()).toContain("2026-10-12 周一 05:00:00");
  expect(footer()).toContain("回到当前");
});
it("return to current re-reads real time and follows subsequent hourly/second ticks", () => {
  store.setHour(5.25);
  expect(store.getContinuousTime()).toBe(5.25);
  expect(footer()).toContain("05:15:00");
  vi.advanceTimersByTime(4000);
  expect(footer()).toContain("05:15:00");
  store.returnToCurrent();
  expect(store.getSnapshot()).toMatchObject({
    hour: 14,
    time: 14,
    followingCurrent: true,
    playbackStartMs: null,
  });
  expect(store.getContinuousTime()).toBeCloseTo(14 + 2 / 3600);
  expect(footer()).not.toContain("回到当前");
  expect(footer()).toContain("14:00:02");
  const now = store.getSnapshot().nowMs;
  vi.advanceTimersByTime(1000);
  expect(store.getSnapshot().nowMs).toBe(now + 1000);
  expect(footer()).toContain("14:00:03");
  vi.setSystemTime(new Date(2026, 9, 12, 15, 0, 1));
  store.syncClock();
  expect(store.getSnapshot()).toMatchObject({ hour: 15, time: 15 });
});
it("a smooth seek stays pinned when its transition finishes", () => {
  store.seekHour(8);
  vi.advanceTimersByTime(250);
  expect(store.getContinuousTime()).toBeGreaterThan(8);
  expect(store.getContinuousTime()).toBeLessThan(13);
  vi.advanceTimersByTime(4000);
  expect(store.getSnapshot()).toMatchObject({
    hour: 8,
    time: 8,
    followingCurrent: false,
  });
  expect(store.getContinuousTime()).toBe(8);
});
it("shows return for a pinned time even within the current hour", () => {
  expect(footer()).not.toContain("回到当前");
  store.setHour(13);
  expect(footer()).toContain("13:00:00");
  expect(footer()).toContain("回到当前");
  vi.advanceTimersByTime(4000);
  expect(footer()).toContain("13:00:00");
});
it("holds the chosen date across real midnight and uses the timeline date after playback wraps", () => {
  store.setHour(9);
  vi.setSystemTime(new Date(2026, 9, 13, 0, 0, 2));
  store.syncClock();
  expect(footer()).toContain("2026-10-12 周一 09:00:00");
  store.returnToCurrent();
  expect(footer()).toContain("2026-10-13 周二 00:00:02");
  store.togglePlayback();
  vi.advanceTimersByTime(24016);
  expect(footer()).toContain("2026-10-14 周三 00:00:02");
  store.setHour(9);
  expect(footer()).toContain("2026-10-14 周三 09:00:00");
  vi.advanceTimersByTime(4000);
  expect(footer()).toContain("2026-10-14 周三 09:00:00");
  store.returnToCurrent();
  expect(store.getPlaybackFrame().nowMs).toBe(Date.now());
});
it("keeps playback continuous and its finished reset unchanged", () => {
  store.setHour(5);
  store.togglePlayback();
  vi.advanceTimersByTime(32);
  const first = store.getContinuousTime();
  vi.advanceTimersByTime(16);
  expect(store.getContinuousTime()).toBeGreaterThan(first);
  expect(store.getContinuousTime()).toBe(store.getPlaybackFrame().time);
  vi.advanceTimersByTime(24016);
  expect(store.getSnapshot().playbackFinished).toBe(true);
  expect(footer()).toContain("↺ 重置");
  store.togglePlayback();
  expect(store.getSnapshot()).toMatchObject({
    followingCurrent: true,
    playbackFinished: false,
    playbackStartMs: null,
  });
  expect(footer()).not.toContain("回到当前");
});
