import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { evaluateOpsSnapshot } from "../src/data/ops/elevator";
import type { OpsDay, OpsCalendar } from "../src/data/ops/model";
import { serveOps } from "./ops-fixture";
import { setTimelineHour } from "./timeline-helper";
test.use({ timezoneId: "Asia/Shanghai" });
const snapshot = async (page: Page) =>
  JSON.parse(
    (await page.locator(".twin-scene").getAttribute("data-scene")) ?? "{}",
  );
async function check(page: Page) {
  const s = await snapshot(page);
  expect(s.opsAvailable).toBe(true);
  expect(s.elevators).toHaveLength(6);
  const c: OpsCalendar = JSON.parse(
    await readFile(
      new URL("../../exports/replay/ops-calendar.json", import.meta.url),
      "utf8",
    ),
  );
  const entry = c.days.find(
    (d) => s.opsAtMs >= d.day_start_ms && s.opsAtMs < d.day_start_ms + 86400000,
  )!;
  const day: OpsDay = JSON.parse(
    await readFile(
      new URL(
        `../../exports/replay/${entry.scenario}.ops.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  day.day_start_ms = entry.day_start_ms;
  const expected = evaluateOpsSnapshot(day, s.opsAtMs).elevators;
  s.elevators.forEach((state: any, i: number) => {
    expect(state).toMatchObject(expected[i]);
    expect(state.y).toBeCloseTo(
      6 + (expected[i].floor - 1) * s.spacing + 0.65,
      6,
    );
  });
  return s;
}
for (const width of [390, 1366])
  test(`six ops lifts follow selection and continuous playback ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await page.route("**/api/**", (r) => r.abort());
    await serveOps(page);
    await page.goto("/?source=file&at=2026-10-12T00:00:06");
    await expect
      .poll(async () => (await snapshot(page)).opsAvailable)
      .toBe(true);
    const fixed = await check(page);
    expect(fixed.opsAtMs).toBe(Date.parse("2026-10-12T00:00:06+08:00"));
    await page.getByRole("button", { name: "透视", exact: true }).click();
    await setTimelineHour(page, 18);
    await expect
      .poll(async () => (await snapshot(page)).opsAtMs)
      .toBe(Date.parse("2026-10-12T18:00:00+08:00"));
    const selected = await check(page);
    await page.waitForTimeout(300);
    expect((await check(page)).elevators).toEqual(selected.elevators);
    await page.getByRole("button", { name: "展开楼层", exact: true }).click();
    await page.waitForTimeout(300);
    await check(page);
    await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
    await page.waitForTimeout(350);
    const playing = await check(page);
    expect(playing.opsAtMs).toBeGreaterThan(fixed.opsAtMs);
    expect(playing.opsAtMs % 3600000).not.toBe(0);
    await page.waitForTimeout(250);
    expect((await check(page)).opsAtMs).toBeGreaterThan(playing.opsAtMs);
    await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
    await page.waitForTimeout(100);
    const paused = await check(page);
    await page.waitForTimeout(250);
    expect((await check(page)).opsAtMs).toBe(paused.opsAtMs);
  });
test("current-time movement uses real elapsed seconds, also with reduced motion", async ({
  page,
}) => {
  const base = new Date("2026-10-12T00:00:06+08:00");
  await page.clock.setFixedTime(base);
  await page.route("**/api/**", (r) => r.abort());
  await serveOps(page);
  await page.goto("/?source=file");
  await expect
    .poll(async () => {
      return (await snapshot(page)).opsAvailable;
    })
    .toBe(true);
  await page.clock.install({ time: base });
  const pauseAt = await page.evaluate(() => Date.now() + 1000);
  await page.clock.pauseAt(pauseAt);
  await page.clock.runFor(32);
  const before = await check(page);
  await page.clock.runFor(1000);
  const after = await check(page);
  expect(Math.abs(after.opsAtMs - before.opsAtMs - 1000)).toBeLessThanOrEqual(
    16,
  );
  expect(after.elevators[0].floor).toBeGreaterThan(before.elevators[0].floor);
  expect(
    (after.elevators[0].floor - before.elevators[0].floor) * 3.8,
  ).toBeLessThanOrEqual((3 * (after.opsAtMs - before.opsAtMs)) / 1000 + 0.001);
  await setTimelineHour(page, 18);
  await page.clock.runFor(100);
  const pinned = await check(page);
  await page.clock.runFor(1000);
  expect((await check(page)).opsAtMs).toBe(pinned.opsAtMs);
});
test("crossing midnight loads the adjacent calendar day", async ({ page }) => {
  await page.route("**/api/**", (r) => r.abort());
  await serveOps(page);
  await page.goto("/?source=file&at=2026-10-12T23:59:59");
  await expect.poll(async () => (await snapshot(page)).opsAvailable).toBe(true);
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await expect
    .poll(async () => (await snapshot(page)).opsAtMs)
    .toBeGreaterThan(Date.parse("2026-10-13T00:00:00+08:00"));
  await expect.poll(async () => (await snapshot(page)).opsAvailable).toBe(true);
  await check(page);
});
test("current scene uses backend-calibrated absolute time", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-12T00:00:01+08:00"));
  await page.route("**/api/**", (r) => r.abort());
  await page.route("**/api/ops/time", (r) =>
    r.fulfill({
      json: {
        schema_version: "1.0",
        epoch_ms: Date.parse("2026-10-12T00:00:06+08:00"),
        timezone: "Asia/Shanghai",
      },
    }),
  );
  await serveOps(page);
  await page.goto("/?source=file", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".twin-scene")).toHaveAttribute("data-scene-ready", "true", { timeout: 30000 });
  await expect.poll(async () => (await snapshot(page)).opsAvailable).toBe(true);
  const s = await check(page);
  expect(s.opsAtMs).toBeGreaterThanOrEqual(
    Date.parse("2026-10-12T00:00:06+08:00"),
  );
  const clock = await page.evaluate(async () => {
    const { opsClock } = await import("/src/data/ops/runtime.ts" as string);
    const host = document.querySelector(".twin-scene")!;
    // Do not compare the last published rAF snapshot against a later protocol turn.
    return new Promise<{ now: number; status: ReturnType<typeof opsClock.getStatus>; local: number; sceneMs: number }>((resolve) => {
      const observer = new MutationObserver(() => {
        const scene = JSON.parse(host.getAttribute("data-scene")!);
        observer.disconnect();
        resolve({ now: opsClock.now(), status: opsClock.getStatus(), local: Date.now(), sceneMs: scene.opsAtMs });
      });
      observer.observe(host, { attributes: true, attributeFilter: ["data-scene"] });
    });
  });
  expect(clock.status.source).toBe("backend");
  expect(clock.now - clock.local).toBeGreaterThan(4000);
  expect(Math.abs(clock.sceneMs - clock.now)).toBeLessThanOrEqual(16);
});
test("unsynced ops parks six cars without a browser error or per-frame requests", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let requests = 0;
  await page.route("**/api/**", (r) => r.abort());
  await page.route(
    (url) => url.pathname.endsWith("/replay/ops-calendar.json"),
    (r) => {
      requests++;
      return r.fulfill({ status: 404, body: "" });
    },
  );
  await page.goto("/?source=file&at=2026-10-12T18:31");
  await expect
    .poll(async () => (await snapshot(page)).elevators?.length)
    .toBe(6);
  await page.waitForTimeout(500);
  const s = await snapshot(page);
  expect(s.opsAvailable).toBe(false);
  for (const lift of s.elevators)
    expect(lift).toMatchObject({ floor: 1, status: "idle", direction: 0 });
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
});
