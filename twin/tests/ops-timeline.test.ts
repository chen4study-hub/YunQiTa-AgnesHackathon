import { it, expect, vi } from "vitest";
import { createOpsTimeline } from "../src/data/ops/runtime";
import type { OpsCalendar, OpsDay } from "../src/data/ops/model";
it("deduplicates per-frame missing files and quietly retries after 30 seconds", async () => {
  let time = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => time);
  try {
    const loader = {
      loadCalendar: vi.fn().mockRejectedValue(new Error("404")),
    } as any;
    const timeline = createOpsTimeline(loader);
    for (let i = 0; i < 100; i++) expect(timeline.getDay(1)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 100; i++) timeline.getDay(1);
    expect(loader.loadCalendar).toHaveBeenCalledTimes(1);
    time = 30001;
    timeline.getDay(1);
    expect(loader.loadCalendar).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    now.mockRestore();
  }
});
it("changes absolute calendar days at midnight and notifies without stale day reuse", async () => {
  const c = {
    days: [
      { date: "2026-10-12", day_start_ms: 0 },
      { date: "2026-10-13", day_start_ms: 86400000 },
    ],
  } as OpsCalendar;
  const loader = {
    loadCalendar: vi.fn().mockResolvedValue(c),
    loadDay: vi.fn(
      async (date: string) =>
        ({ day_start_ms: date.endsWith("12") ? 0 : 86400000 }) as OpsDay,
    ),
  } as any;
  const timeline = createOpsTimeline(loader),
    notify = vi.fn(),
    stop = timeline.subscribe(notify);
  expect(timeline.getDay(1)).toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(timeline.getDay(1)).toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(timeline.getDay(1)?.day_start_ms).toBe(0);
  expect(timeline.getDay(86400000)).toBeNull();
  await new Promise((r) => setTimeout(r, 0));
  expect(timeline.getDay(86400000)?.day_start_ms).toBe(86400000);
  expect(loader.loadDay.mock.calls.map(([d]: string[]) => d)).toEqual([
    "2026-10-12",
    "2026-10-13",
  ]);
  expect(notify).toHaveBeenCalledTimes(3);
  stop();
});
