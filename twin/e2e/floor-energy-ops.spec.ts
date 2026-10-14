import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { evaluateOpsSnapshot } from "../src/data/ops/elevator";
import type { OpsDay, OpsCalendar, OpsFloorsFile } from "../src/data/ops/model";
import { setTimelineHour } from "./timeline-helper";
import { serveOps } from "./ops-fixture";
import { freezeTestHmr } from "./shell-scroll-policy";

test.use({ timezoneId: "Asia/Shanghai" });
test.beforeEach(async ({ page }) => {
  await freezeTestHmr(page);
  await serveOps(page);
  await page.route("**/api/**", (r) => r.abort());
});
async function json<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(
      new URL(`../../exports/replay/${name}`, import.meta.url),
      "utf8",
    ),
  );
}
const loader = {
  async loadAt(at: number) {
    const calendar = await json<OpsCalendar>("ops-calendar.json");
    const entry = calendar.days.find(
      (d) => at >= d.day_start_ms && at < d.day_start_ms + 86400000,
    )!;
    const day = await json<OpsDay>(`${entry.scenario}.ops.json`);
    day.day_start_ms = entry.day_start_ms;
    if (day.meta.floors_file) {
      const side = await json<OpsFloorsFile>(day.meta.floors_file);
      day.hours = day.hours.map((h) => ({
        ...h,
        floors: side.hours.find((r) => r.offset_ms === h.offset_ms)!.floors,
      }));
    }
    return day;
  },
};
const scene = async (page: Page) =>
  JSON.parse(
    (await page.locator(".twin-scene").getAttribute("data-scene")) ?? "{}",
  );
const lifts = async (page: Page) =>
  page.locator(".floors-lift-shaft").evaluateAll((es) =>
    es.map((el) => ({
      id: el
        .parentElement!.querySelector("h3")!
        .childNodes[0].textContent!.trim(),
      floor: Number((el as HTMLElement).dataset.floor),
    })),
  );
async function show(page: Page, name: string, root: string) {
  await page.getByRole("button", { name }).click();
  await expect(page.locator(root)).toBeVisible({ timeout: 15000 });
}
for (const size of [
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
])
  test(`ops lifts refresh, 3D parity and selected/playback data ${size.width}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.setViewportSize(size);
    const at = Date.parse("2026-10-12T00:00:06+08:00");
    const day = await loader.loadAt(at);
    await page.goto("/?source=file&at=2026-10-12T00:00:06", {
      waitUntil: "domcontentloaded",
    });
    await expect
      .poll(async () => (await scene(page)).opsAvailable, { timeout: 15000 })
      .toBe(true);
    const before3d = await scene(page);
    expect(before3d.opsAtMs).toBe(at);
    await show(page, "楼层与电梯", ".floors-page");
    await expect(page.locator(".floors-lift-shaft")).toHaveCount(6);
    const initial = await lifts(page),
      expected = evaluateOpsSnapshot(day, at).elevators;
    for (const lift of initial) {
      expect(
        Math.abs(lift.floor - expected.find((e) => e.id === lift.id)!.floor),
      ).toBeLessThanOrEqual(0.05);
      expect(
        Math.abs(
          lift.floor -
            before3d.elevators.find((e: any) => e.id === lift.id).floor,
        ),
      ).toBeLessThanOrEqual(0.05);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await show(page, "楼层与电梯", ".floors-page");
    await expect(page.locator(".floors-lift-shaft")).toHaveCount(6);
    const refreshed = await lifts(page);
    for (const lift of refreshed)
      expect(
        Math.abs(lift.floor - initial.find((e) => e.id === lift.id)!.floor),
      ).toBeLessThanOrEqual(0.05);
    await setTimelineHour(page, 18);
    await expect(page.locator(".floors-page")).toHaveAttribute(
      "data-time",
      "18",
    );
    const load = page
      .locator(".floors-metrics > div")
      .filter({ hasText: "楼层负荷" })
      .locator(".floors-number");
    await expect(load).toHaveText(
      day.hours[18].floors[21].floor_actual_kw.toLocaleString("en-US", {
        maximumFractionDigits: 1,
      }),
    );
    const selected = await lifts(page);
    await show(page, "总览", ".twin-scene");
    await expect
      .poll(async () => (await scene(page)).opsAtMs)
      .toBe(day.day_start_ms + 18 * 3600000);
    const selected3d = await scene(page);
    for (const lift of selected)
      expect(
        Math.abs(
          lift.floor -
            selected3d.elevators.find((e: any) => e.id === lift.id).floor,
        ),
      ).toBeLessThanOrEqual(0.05);
    await show(page, "能源与告警", ".energy-page");
    await expect(page.locator(".energy-page")).toHaveAttribute(
      "data-time",
      "18",
    );
    await expect(page.locator(".energy-donut-total .energy-number")).toHaveText(
      day.hours[18].actual_kw.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    );
    const records =
      day.alerts.filter((r) => r.offset_ms <= 18 * 3600000).length +
      day.work_orders.filter((r) => r.offset_ms <= 18 * 3600000).length;
    await expect(page.locator("[data-alert-id]")).toHaveCount(records);
    await setTimelineHour(page, 10);
    await expect(page.locator(".energy-page")).toHaveAttribute(
      "data-time",
      "10",
    );
    await expect(page.locator(".energy-donut-total .energy-number")).toHaveText(
      day.hours[10].actual_kw.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    );
    await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
    await expect
      .poll(async () =>
        Number(await page.locator(".energy-page").getAttribute("data-time")),
      )
      .not.toBe(10);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
    const paused = Number(
      await page.locator(".energy-page").getAttribute("data-time"),
    );
    await page.waitForTimeout(150);
    expect(
      Number(await page.locator(".energy-page").getAttribute("data-time")),
    ).toBe(paused);
    const clock = (await page.locator(".clock").textContent())!
      .match(/(\d{2}):(\d{2}):(\d{2})/)!
      .slice(1)
      .map(Number);
    const current =
      day.day_start_ms + (clock[0] * 3600 + clock[1] * 60 + clock[2]) * 1000;
    const currentDay = await loader.loadAt(current);
    const currentHour = evaluateOpsSnapshot(currentDay, current).hour;
    await expect(page.locator(".energy-donut-total .energy-number")).toHaveText(
      currentHour.actual_kw.toLocaleString("en-US", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    );
    await show(page, "楼层与电梯", ".floors-page");
    await expect(page.locator(".floors-lift-shaft")).toHaveCount(6);
    const pausedLifts = await lifts(page);
    await show(page, "总览", ".twin-scene");
    await expect
      .poll(async () => (await scene(page)).opsAtMs)
      .toBeGreaterThanOrEqual(current);
    const paused3d = await scene(page);
    for (const lift of pausedLifts)
      expect(
        Math.abs(
          lift.floor -
            paused3d.elevators.find((e: any) => e.id === lift.id).floor,
        ),
      ).toBeLessThanOrEqual(0.05);
  });
test("playback crosses midnight using the next calendar day and a real loadWindow", async ({
  page,
}) => {
  test.setTimeout(60000);
  const day = await loader.loadAt(Date.parse("2026-10-12T23:59:58+08:00"));
  await page.goto("/?source=file&at=2026-10-12T23:59:58", {
    waitUntil: "domcontentloaded",
  });
  await show(page, "能源与告警", ".energy-page");
  await expect(page.locator(".energy-donut-total")).toBeVisible();
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await expect(page.locator(".energy-page")).toHaveAttribute(
    "data-date",
    /2026-10-13/,
  );
  await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
  const pausedTime = Number(
    await page.locator(".energy-page").getAttribute("data-time"),
  );
  const next = await loader.loadAt(day.day_start_ms + 86400000);
  const hour = Math.floor(pausedTime);
  await expect(page.locator(".energy-donut-total .energy-number")).toHaveText(
    next.hours[hour].actual_kw.toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  );
  await show(page, "楼层与电梯", ".floors-page");
  await expect(page.locator(".floors-page")).toHaveAttribute(
    "data-date",
    /2026-10-13/,
  );
  await expect(page.locator(".floors-lift-shaft")).toHaveCount(6);
  const floor = page
    .locator(".floors-metrics > div")
    .filter({ hasText: "楼层负荷" })
    .locator(".floors-number");
  await expect(floor).toHaveText(
    // One-decimal floor readings retain .0, just like the daytime assertion.
    next.hours[hour].floors[21].floor_actual_kw.toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  );
});
test("missing ops file exposes retry and never falls back to replay", async ({
  page,
}) => {
  test.setTimeout(60000);
  const calendarRoute = (url: URL) =>
    url.pathname.endsWith("/replay/ops-calendar.json");
  await page.route(calendarRoute, (r) =>
    r.fulfill({ status: 404, body: "missing" }),
  );
  await page.goto("/?source=file&at=2026-10-12T14:00", {
    waitUntil: "domcontentloaded",
  });
  for (const [name, root] of [
    ["楼层与电梯", ".floors-page"],
    ["能源与告警", ".energy-page"],
  ]) {
    await show(page, name, root);
    await expect(page.locator(root)).toContainText("数据暂不可用");
    await expect(
      page.locator(root + " .floors-lift-car," + root + " .energy-number"),
    ).toHaveCount(0);
    await expect(
      page.locator(root).getByRole("button", { name: "重试" }),
    ).toBeVisible();
  }
  await page.unroute(calendarRoute);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".energy-donut-total")).toBeVisible();
});
