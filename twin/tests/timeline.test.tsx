import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Timeline,
  timelineTimeAtX,
  timelineHeadTime,
} from "../src/components/Timeline";
import { DashboardStore } from "../src/state/store";
import { MockAdapter } from "../src/data/adapters";
it("uses exact local clock for the live head while leaving selected and playback positions untouched", () => {
  const nowMs = new Date(2026, 9, 12, 18, 31, 30, 250).getTime();
  const frame = { nowMs, time: 18, elapsedHours: 0 };
  expect(timelineHeadTime(frame, true, null)).toBeCloseTo(
    18 + 31 / 60 + 30.25 / 3600,
    10,
  );
  expect(
    timelineHeadTime({ ...frame, nowMs: nowMs + 60_000 }, true, null),
  ).toBeCloseTo(18 + 32 / 60 + 30.25 / 3600, 10);
  expect(timelineHeadTime({ ...frame, time: 9 }, false, null)).toBe(9);
  expect(timelineHeadTime({ ...frame, time: 9.5 }, false, null)).toBe(9.5);
  expect(timelineHeadTime({ ...frame, time: 19.75 }, false, nowMs)).toBe(19.75);
  expect(timelineHeadTime({ ...frame, time: 19.75 }, true, nowMs)).toBe(19.75);
  expect(
    timelineHeadTime(
      { ...frame, nowMs: new Date(2026, 9, 13, 0, 1).getTime(), time: 0 },
      true,
      null,
    ),
  ).toBeCloseTo(1 / 60, 10);
});
it("initializes the live cursor from the same time as 3D without changing the integer data hour", () => {
  const store = new DashboardStore(new MockAdapter(), undefined, {
    query: "?at=2026-10-12T18:31:00",
  });
  try {
    const frame = store.getPlaybackFrame();
    expect(store.getSnapshot().time).toBe(18);
    expect(timelineHeadTime(frame, true, null)).toBe(store.getContinuousTime());
    const html = renderToStaticMarkup(
      <Timeline
        store={store}
        time={18}
        playing={false}
        data={null}
        onChange={() => {}}
      />,
    );
    const fraction = Number(html.match(/--cursor-fraction:([\d.]+)/)?.[1]);
    expect(fraction).toBeCloseTo(31 / 60, 10);
    store.setHour(9);
    expect(timelineHeadTime(store.getPlaybackFrame(), false, null)).toBe(
      store.getContinuousTime(),
    );
  } finally {
    store.dispose();
  }
});
it("maps clicks to cells and drags to continuous hours, clamps both endpoints", () => {
  expect(timelineTimeAtX(210, 100, 240, false)).toBe(11);
  expect(timelineTimeAtX(215, 100, 240, true)).toBe(11.5);
  expect(timelineTimeAtX(-10, 100, 240, true)).toBe(0);
  expect(timelineTimeAtX(500, 100, 240, true)).toBe(23);
});
it("has one slider with numeric aria state and no button semantics in its 24 cells", () => {
  const html = renderToStaticMarkup(
    <Timeline time={11.5} playing={false} data={null} onChange={() => {}} />,
  );
  expect(html.match(/role="slider"/g)).toHaveLength(1);
  expect(html).toContain('aria-valuenow="11.5"');
  expect(html).toContain('aria-valuetext="11:30:00"');
  expect(html.match(/data-hour=/g)).toHaveLength(24);
  expect(html).not.toContain("<button");
  expect(html).not.toContain('role="button"');
});
