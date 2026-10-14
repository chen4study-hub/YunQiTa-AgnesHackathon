import { afterEach, expect, it, vi } from "vitest";
import { DashboardStore, type PlaybackFrame } from "../src/state/store";
import { MockAdapter } from "../src/data/adapters";
import { timelineHeadTime } from "../src/components/Timeline";
import { localClockText } from "../src/config/localClock";
afterEach(() => vi.unstubAllGlobals());
it("timeline and clock share one immutable sample when another subscriber crosses the hour", () => {
  let wall = 1000;
  let tick: FrameRequestCallback = () => {};
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      tick = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const store = new DashboardStore(
    new MockAdapter(),
    undefined,
    { query: "?at=2026-10-12T13:59:59" },
    { wallNow: () => wall },
  );
  const seen: PlaybackFrame[] = [];
  let clock = "",
    head = 0;
  const reads: PlaybackFrame[] = [];
  store.subscribePlayback((frame) => {
    seen.push(frame);
    head = timelineHeadTime(frame, false, store.getSnapshot().playbackStartMs);
    wall += 1;
    reads.push(store.getPlaybackFrame());
  });
  store.subscribePlayback((frame) => {
    seen.push(frame);
    clock = localClockText(frame.nowMs);
  });
  try {
    store.togglePlayback();
    wall = 1000;
    tick(0);
    expect(clock).toBe("13:59:59");
    expect((head % 1) * 60).toBeCloseTo(59 + 59 / 60, 8);
    expect(seen.at(-1)).toBe(seen.at(-2));
    // Even a subscriber querying the getter after a slow callback sees this shared sample.
    expect(reads.at(-1)).toBe(seen.at(-1));
    wall = 1001;
    tick(16);
    expect(clock).toBe("14:00:02");
    expect((head % 1) * 60).toBeCloseTo(2.6 / 60, 8);
    expect(seen.at(-1)).toBe(seen.at(-2));
    expect(reads.at(-1)).toBe(seen.at(-1));
  } finally {
    store.dispose();
  }
});
