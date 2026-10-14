import { expect, test, type Page } from "@playwright/test";
import { opsDay, assertOpsAlerts, isolateOpsTest } from "./ops-test-data";
import { opsDateTime, opsTimeLabel } from "../src/pages/energy/time";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
async function check(
  page: Page,
  day: string,
  window?: { start: number; end: number },
) {
  await expect(page.locator(".energy-page")).toHaveAttribute(
    "data-date",
    `${day} ${day.endsWith("12") ? "周一" : "周二"}`,
  );
  const header = page.locator(".energy-alerts .energy-heading time");
  await expect(header).not.toContainText(/次日|昨日|前日/);
  expect(await header.getAttribute("datetime")).toMatch(new RegExp(`^${day}T`));
  const rows = await page
    .locator(".energy-alert-table tbody time")
    .evaluateAll((es) =>
      es.map((e) => ({
        text: e.textContent,
        date: e.getAttribute("datetime"),
      })),
    );
  // Empty early-morning Ops records are valid; never pad midnight alerts.
  for (const r of rows) {
    const event = Date.parse(r.date!);
    expect(Number.isFinite(event)).toBe(true);
    expect(r.date).toBe(opsDateTime(event));
    expect(r.text).toBe(opsTimeLabel(event, Date.parse(day + "T12:00:00")));
  }
  const source = await (
    await page.request.get("/src/pages/energy/SmoothChart.tsx")
  ).text();
  const moduleUrl = source.match(/from ["']([^"']*echarts\.js[^"']*)["']/)![1];
  const options = await page
    .locator(".energy-timeseries")
    .evaluateAll(async (es, moduleUrl) => {
      const ec = await import(/* @vite-ignore */ moduleUrl);
      return es.map((e) => {
        const c = ec.getInstanceByDom(e),
          o = c.getOption(),
          axis = o.xAxis[0],
          mark = o.series[0].markLine.data[0];
        return {
          labels: [0, 6, 12, 18, 24].map(axis.axisLabel.formatter),
          cursor: mark.label.show,
          min: axis.min,
          max: axis.max,
        };
      });
    }, moduleUrl);
  for (const o of options) {
    expect(o.labels).toEqual([
      "00:00",
      "06:00",
      "12:00",
      "18:00",
      "次日\n00:00",
    ]);
    expect(o.cursor).toBe(false);
    const midnight = Date.parse(`${day}T00:00:00`);
    expect(o.min).toBe(
      window ? Math.floor((window.start - midnight) / 3600000) : 0,
    );
    expect(o.max).toBe(
      window ? Math.ceil((window.end - midnight) / 3600000) : 24,
    );
  }
  const a = await page.locator(".energy-cursor-time").boundingBox(),
    b = await page.locator(".energy-ems .energy-timeseries").boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(
    Math.min(a!.y + a!.height, b!.y + b!.height) - Math.max(a!.y, b!.y),
  ).toBeLessThanOrEqual(0);
}
test("22:30 playback crosses midnight: current date, point datetimes, horizontal cursor and stable charts", async ({
  page,
}) => {
  await page.goto("/?source=file&at=2026-10-12T22:30");
  await expect(page.locator(".bottombar")).toBeVisible();
  await page.getByRole("button", { name: "能源与告警" }).click();
  await expect(page.locator(".energy-timeseries")).toHaveCount(2);
  await check(page, "2026-10-12");
  const ids = await page
    .locator(".energy-timeseries")
    .evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.chartId));
  await page.clock.install();
  await page.getByRole("button", { name: /播放/ }).click();
  await page.clock.runFor(2000);
  await expect(page.locator(".bottombar .clock")).toContainText("10-13");
  await page.getByRole("button", { name: /暂停/ }).click();
  await page.waitForTimeout(500);
  await check(page, "2026-10-13", {
    start: Date.parse("2026-10-12T22:30:00"),
    end: Date.parse("2026-10-13T22:30:00"),
  });
  expect(
    await page
      .locator(".energy-timeseries")
      .evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.chartId)),
  ).toEqual(ids);
});
test("paused early-morning route labels midnight rows on current day", async ({
  page,
}) => {
  await page.goto("/?source=file&at=2026-10-13T01:47:47");
  await expect(page.locator(".bottombar")).toBeVisible();
  await page.getByRole("button", { name: "能源与告警" }).click();
  await check(page, "2026-10-13");
  await assertOpsAlerts(page, opsDay("2026-10-13"), 1 + 47 / 60 + 47 / 3600);
  await expect(
    page.locator(".energy-alerts .energy-heading time"),
  ).toContainText("01:47");
});
