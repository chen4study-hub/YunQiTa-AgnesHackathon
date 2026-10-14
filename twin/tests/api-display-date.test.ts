import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { DashboardStore } from "../src/state/store";
import { MockAdapter } from "../src/data/adapters";
import { loadSchedule, chat } from "../src/pages/agent/api";
import { streamChat } from "../src/pages/agent/chat-stream";
import { liveScheduleKey } from "../src/data/liveSchedule";
import { stubRaf } from "./raf-test-helper";
beforeEach(() => {
  vi.useFakeTimers();
  stubRaf();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("all three transports default to bottom-bar YYYY-MM-DD, including playback midnight; schedule cache separates dates", async () => {
  const store = new DashboardStore(new MockAdapter(), async () => null, {
    query: "?at=2026-10-12T23:30&scenario=normal",
  });
  await store.initialize();
  const data = store.getSnapshot().data!;
  const requests: { url: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      throw new Error("offline");
    }),
  );
  const send = async () => {
    await loadSchedule(data, 23, "date-test");
    await chat("时间", "date-test", data.hours[23].t);
    await streamChat("时间", "date-test", data.hours[23].t, () => {});
  };
  try {
    await send();
    expect(requests.map((r) => r.url.split("/").slice(-2).join("/"))).toEqual([
      "api/schedule",
      "api/chat",
      "chat/stream",
      "api/chat",
    ]);
    expect(requests.every((r) => r.body.display_date === "2026-10-12")).toBe(
      true,
    );
    store.togglePlayback();
    vi.advanceTimersByTime(720);
    expect(new Date(store.getPlaybackFrame().nowMs).getDate()).toBe(13);
    await send();
    expect(requests.slice(4)).toHaveLength(4);
    expect(
      requests.slice(4).every((r) => r.body.display_date === "2026-10-13"),
    ).toBe(true);
    expect(requests.filter((r) => r.url.endsWith("/schedule"))).toHaveLength(2);
    await loadSchedule(data, 23, "date-test");
    expect(requests.filter((r) => r.url.endsWith("/schedule"))).toHaveLength(2);
    expect(liveScheduleKey("normal", "tower", "origin", "2026-10-12")).not.toBe(
      liveScheduleKey("normal", "tower", "origin", "2026-10-13"),
    );
    await loadSchedule(data, 23, "date-test", "2026-11-01");
    expect(requests.at(-1)!.body.display_date).toBe("2026-11-01");
  } finally {
    store.dispose();
  }
});
it("store schedule loader receives captured date and cannot reuse same origin cached on another display day", async () => {
  let now = new Date(2026, 9, 12, 14).getTime();
  const loader = vi.fn(async (..._args: unknown[]) => null);
  const store = new DashboardStore(new MockAdapter(), loader, {
    now: () => now,
    query: "?scenario=normal",
  });
  try {
    await store.initialize();
    await store.ensureLiveSchedule();
    expect(loader.mock.calls[0][3]).toBe("2026-10-12");
    now = new Date(2026, 9, 13, 14).getTime();
    store.syncClock();
    await store.ensureLiveSchedule();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1][3]).toBe("2026-10-13");
  } finally {
    store.dispose();
  }
});
