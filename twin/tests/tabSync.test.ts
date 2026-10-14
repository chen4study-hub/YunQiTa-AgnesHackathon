import { DashboardStore } from "../src/state/store";
import { MockAdapter } from "../src/data/adapters";
import { stubRaf } from "./raf-test-helper";
import { afterEach, expect, it, vi } from "vitest";
import {
  TabTimeSync,
  elapsedAt,
  isSharedTimeState,
  sharedWallNow,
  type SharedTimeState,
  type TimeChannel,
} from "../src/state/tabSync";

class TestTimeBus {
  channels = new Set<TimeChannel & { receive: (data: unknown) => void }>();
  messages: unknown[] = [];
  factory = () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const channel = {
      receive: (data: unknown) =>
        listeners.forEach((fn) => fn({ data } as MessageEvent)),
      postMessage: (data: unknown) => {
        this.messages.push(structuredClone(data));
        queueMicrotask(() =>
          this.channels.forEach((peer) => {
            if (peer !== channel) peer.receive(structuredClone(data));
          }),
        );
      },
      addEventListener: (_: "message", fn: (event: MessageEvent) => void) => {
        listeners.add(fn);
      },
      removeEventListener: (
        _: "message",
        fn: (event: MessageEvent) => void,
      ) => {
        listeners.delete(fn);
      },
      close: () => {
        this.channels.delete(channel);
      },
    };
    this.channels.add(channel);
    return channel;
  };
}
const initial = (): SharedTimeState => ({
  followingCurrent: true,
  selectedDayMs: null,
  selectedTime: 14,
  playbackStartMs: null,
  elapsedHours: 0,
  runStartedAtMs: null,
  playing: false,
  finished: false,
});
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const stores: DashboardStore[] = [];
afterEach(() => {
  stores.forEach((s) => s.dispose());
  stores.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("uses wall elapsed time, pause budget and the future server offset seam", () => {
  const state = {
    ...initial(),
    followingCurrent: false,
    playing: true,
    playbackStartMs: 1,
    runStartedAtMs: 1000,
    elapsedHours: 2,
  };
  expect(elapsedAt(state, 4500)).toBe(5.5);
  expect(elapsedAt(state, 500)).toBe(2);
  expect(elapsedAt(state, 99999)).toBe(24);
  expect(elapsedAt({ ...state, playing: false }, 99999)).toBe(2);
  expect(sharedWallNow({ wallNow: () => 1000, offsetMs: () => 200 })).toBe(
    1200,
  );
});
it("requests the existing snapshot, resolves simultaneous writes and never echoes", async () => {
  const bus = new TestTimeBus();
  let a = initial(),
    b = initial();
  const first = new TabTimeSync(
    () => a,
    (value) => {
      a = value;
    },
    { channelFactory: bus.factory },
  );
  a = { ...a, followingCurrent: false, selectedDayMs: 123, selectedTime: 5 };
  first.publish();
  const second = new TabTimeSync(
    () => b,
    (value) => {
      b = value;
    },
    { channelFactory: bus.factory },
  );
  await flush();
  expect(b).toEqual(a);
  const count = bus.messages.length;
  await flush();
  expect(bus.messages).toHaveLength(count);
  a = { ...a, selectedTime: 7 };
  b = { ...b, selectedTime: 9 };
  first.publish();
  second.publish();
  await flush();
  expect(a).toEqual(b);
  const saved = { ...a };
  bus.channels.forEach((channel) =>
    channel.receive({
      version: 1,
      type: "state",
      sender: "stale",
      revision: { counter: 0, sender: "" },
      state: initial(),
    }),
  );
  expect(a).toEqual(saved);
  expect(b).toEqual(saved);
  first.close();
  second.close();
  expect(bus.channels.size).toBe(0);
});
it("rejects malformed snapshots and stays local when BroadcastChannel fails", () => {
  expect(isSharedTimeState(initial())).toBe(true);
  for (const patch of [
    { selectedTime: NaN },
    { elapsedHours: 25 },
    { playing: true },
    { finished: true },
    { selectedDayMs: Infinity },
  ])
    expect(isSharedTimeState({ ...initial(), ...patch })).toBe(false);
  const apply = vi.fn();
  const sync = new TabTimeSync(initial, apply, {
    channelFactory: () => {
      throw new Error("blocked");
    },
  });
  expect(() => sync.publish()).not.toThrow();
  sync.close();
  expect(apply).not.toHaveBeenCalled();
});

it("two stores share time only, late join during initialization, pause/resume and finished reset", async () => {
  vi.useFakeTimers();
  stubRaf();
  vi.setSystemTime(new Date(2026, 9, 12, 22, 23, 5));
  const bus = new TestTimeBus();
  const make = () => {
    const s = new DashboardStore(
      new MockAdapter(),
      undefined,
      { query: "" },
      { channelFactory: bus.factory },
    );
    stores.push(s);
    return s;
  };
  const a = make();
  await a.initialize();
  a.setPage("energy");
  a.setSwitch("xray", true);
  a.selectFloor(12);
  a.togglePlayback();
  vi.advanceTimersByTime(500);
  const b = make();
  await flush();
  await b.initialize();
  expect(b.getSnapshot()).toMatchObject({
    playing: true,
    page: "overview",
    selectedFloor: null,
    switches: { xray: false },
  });
  expect(b.getPlaybackFrame()).toEqual(a.getPlaybackFrame());
  vi.advanceTimersByTime(500);
  a.pause();
  await flush();
  expect(b.getPlaybackFrame()).toEqual(a.getPlaybackFrame());
  const paused = a.getPlaybackFrame().nowMs;
  vi.advanceTimersByTime(3000);
  expect(b.getPlaybackFrame().nowMs).toBe(paused);
  b.togglePlayback();
  await flush();
  vi.advanceTimersByTime(128);
  expect(a.getPlaybackFrame()).toEqual(b.getPlaybackFrame());
  a.setHour(5.25);
  await flush();
  expect(b.getPlaybackFrame().time).toBe(5.25);
  expect(b.getPlaybackFrame().nowMs).toBe(a.getPlaybackFrame().nowMs);
  b.returnToCurrent();
  await flush();
  expect(a.getSnapshot().followingCurrent).toBe(true);
  expect(a.getPlaybackFrame().nowMs).toBe(Date.now());
  a.togglePlayback();
  await flush();
  vi.advanceTimersByTime(24032);
  await flush();
  expect(a.getSnapshot().playbackFinished).toBe(true);
  expect(b.getSnapshot().playbackFinished).toBe(true);
  b.togglePlayback();
  await flush();
  expect(a.getSnapshot()).toMatchObject({
    followingCurrent: true,
    playing: false,
    playbackFinished: false,
    playbackStartMs: null,
  });
  const payloads = bus.messages.filter((m: any) => m.type === "state") as {
    state: SharedTimeState;
  }[];
  for (const message of payloads)
    expect(Object.keys(message.state).sort()).toEqual(
      Object.keys(initial()).sort(),
    );
});
it("broadcasts each control before notifying local subscribers and applies remote pause without RAF", async () => {
  vi.useFakeTimers();
  stubRaf();
  const bus = new TestTimeBus();
  const a = new DashboardStore(
    new MockAdapter(),
    undefined,
    { query: "?at=2026-10-12T14:00" },
    { channelFactory: bus.factory },
  );
  const b = new DashboardStore(
    new MockAdapter(),
    undefined,
    { query: "?at=2026-10-12T14:00" },
    { channelFactory: bus.factory },
  );
  stores.push(a, b);
  await flush();
  let expectedPlaying = true;
  const unsubscribe = a.subscribe(() => {
    const latest = bus.messages
      .filter((message: any) => message.type === "state")
      .at(-1) as { state: SharedTimeState };
    expect(latest.state.playing).toBe(expectedPlaying);
  });
  a.togglePlayback();
  await flush();
  expectedPlaying = false;
  a.pause();
  await flush();
  expect(b.getSnapshot().playing).toBe(false);
  expect(b.getPlaybackFrame()).toEqual(a.getPlaybackFrame());
  a.setHour(5);
  await flush();
  expect(b.getPlaybackFrame().time).toBe(5);
  a.returnToCurrent();
  await flush();
  expect(b.getSnapshot().followingCurrent).toBe(true);
  unsubscribe();
});
it("catches up after a stalled frame without accumulating ticks, and preserves fractional 3D time", async () => {
  vi.useFakeTimers();
  stubRaf();
  let wall = 1000;
  const store = new DashboardStore(
    new MockAdapter(),
    undefined,
    { query: "?at=2026-10-12T22:00" },
    { wallNow: () => wall },
  );
  stores.push(store);
  await store.initialize();
  store.togglePlayback();
  wall = 4750;
  vi.advanceTimersByTime(16);
  expect(store.getPlaybackFrame().elapsedHours).toBe(3.75);
  expect(store.getContinuousTime()).toBe(1.75);
  wall = 5100;
  store.pause();
  expect(store.getPlaybackFrame().elapsedHours).toBe(4.1);
  wall = 9000;
  store.togglePlayback();
  wall = 9125;
  vi.advanceTimersByTime(16);
  expect(store.getPlaybackFrame().elapsedHours).toBeCloseTo(4.225);
});
