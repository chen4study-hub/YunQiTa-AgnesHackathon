import { expect, it, vi, beforeEach, afterEach } from "vitest";
import {stubRaf} from './raf-test-helper';
beforeEach(stubRaf);afterEach(()=>vi.unstubAllGlobals());
import { DashboardStore } from "../src/state/store";
import { MockAdapter, mockReplay } from "../src/data/adapters";
import { replayDecision } from "../src/pages/agent/data";
import { liveScheduleKey, type LiveSchedule } from "../src/data/liveSchedule";
const remote = (scenario = "normal", index = 14): LiveSchedule => ({
  ...replayDecision(mockReplay(scenario), index),
  source: "schedule",
  selectionSource: "rule",
  explanationSource: "template",
  battery: 123.4,
});
it("deduplicates current-hour requests across pages and caches scenario/origin results without touching replay", async () => {
  const loader = vi.fn(async () => remote()),
    store = new DashboardStore(new MockAdapter(), loader, {query:'?at=2026-10-12T14:00'});
  await store.initialize();
  const original = structuredClone(store.getSnapshot().data);
  await Promise.all([store.ensureLiveSchedule(), store.ensureLiveSchedule()]);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(store.getLiveSchedule()?.battery).toBe(123.4);
  store.setPage("agent");
  await store.ensureLiveSchedule();
  store.setPage("overview");
  expect(loader).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().data).toEqual(original);
  const key = liveScheduleKey(
    "normal",
    original!.meta.building_id,
    original!.hours[14].t,
    '2026-10-12',
  );
  expect(store.getSnapshot().liveSchedules[key]?.explanationSource).toBe(
    "template",
  );
  store.setHour(13);
  expect(store.getLiveSchedule()).toBeNull();
  store.setHour(14);
  expect(store.getLiveSchedule()?.battery).toBe(123.4);
  await store.loadScenario("peak");
  expect(store.getLiveSchedule()).toBeNull();
  await store.loadScenario("normal");
  expect(store.getLiveSchedule()?.battery).toBe(123.4);
  store.dispose();
});
it("late response is cached only under its captured scenario/origin, never overrides another hour", async () => {
  let resolve!: (v: LiveSchedule) => void;
  const store = new DashboardStore(
    new MockAdapter(),
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await store.initialize();
  store.setHour(14);
  const pending = store.ensureLiveSchedule();
  await Promise.resolve();
  store.setHour(13);
  await store.loadScenario("peak");
  resolve(remote());
  await pending;
  expect(store.getLiveSchedule()).toBeNull();
  expect(store.getSnapshot().scenario).toBe("peak");
  await store.loadScenario("normal");
  store.setHour(14);
  expect(store.getLiveSchedule()?.battery).toBe(123.4);
  store.dispose();
});
it("failed and mismatched responses fall back and are not automatically retried", async () => {
  for (const value of [null, { ...remote(), t: "wrong-origin" }]) {
    const loader = vi.fn(async () => value),
      store = new DashboardStore(new MockAdapter(), loader, {query:'?at=2026-10-12T14:00'});
    await store.initialize();
    await store.ensureLiveSchedule();
    await store.ensureLiveSchedule();
    expect(store.getLiveSchedule()).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
    store.dispose();
  }
});
it("playback/fractional seek never schedules and disposal ignores in-flight updates", async () => {
  const loader = vi.fn(async () => remote()),
    store = new DashboardStore(new MockAdapter(), loader, {query:'?at=2026-10-12T14:00'});
  await store.initialize();
  store.setHour(14.5);
  await store.ensureLiveSchedule();
  store.togglePlayback();
  await store.ensureLiveSchedule();
  expect(loader).not.toHaveBeenCalled();
  store.dispose();
  let resolve!: (v: LiveSchedule) => void;
  const late = new DashboardStore(
    new MockAdapter(),
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await late.initialize();
  late.setHour(14);
  const request = late.ensureLiveSchedule();
  await Promise.resolve();
  late.dispose();
  resolve(remote());
  await request;
  expect(late.getLiveSchedule()).toBeNull();
});
