import { seekPageHour } from "./page-seek";
import { test, expect, type Page } from "@playwright/test";
import { opsDay, isolateOpsTest } from "./ops-test-data";
import { evaluateOpsSnapshot } from "../src/data/ops/elevator";
import { assertShellScrolling } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => isolateOpsTest(page));

async function shellBoxes(page: Page) {
  return Promise.all([
    page.locator(".topbar").boundingBox(),
    page.locator(".bottombar").boundingBox(),
  ]);
}
async function assertShell(
  page: Page,
  baseline: Awaited<ReturnType<typeof shellBoxes>>,
) {
  const boxes = await shellBoxes(page);
  boxes.forEach((box, index) => {
    expect(box).not.toBeNull();
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(box![key]).toBeCloseTo(baseline[index]![key], 2);
    }
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator(".page-content")
      .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  ).toBe(true);
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
]) {
  test(`all tabs preserve shell position and prevent horizontal overflow ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-10-12T00:00:06");
    await expect(page.locator(".overview-grid")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const baseline = await shellBoxes(page);
    for (const name of [
      "总览",
      "预测与风险",
      "Agent 决策",
      "楼层与电梯",
      "能源与告警",
      "关于",
      "楼层与电梯",
      "总览",
    ]) {
      await test.step(`tab ${name}`, async () => {
        await page.getByRole("button", { name }).click();
        await page.waitForTimeout(350);
        await assertShell(page, baseline);
      });
    }
  });

  test(`floor dashboard ${viewport.width}px: selection, layout and absolute-time Ops cars`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?source=file&at=2026-10-12T00:00:06");
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    await expect(page.locator(".floors-lift-table tbody tr")).toHaveCount(6);
    await page.getByRole("combobox", { name: "选择楼层" }).selectOption("22");
    await expect(page.locator(".floors-detail-card h2")).toContainText("22F");
    await expect(page.locator(".floors-temperature-display")).toHaveCount(6);
    await expect(page.locator(".floors-zone-setting")).toHaveCount(6);
    await expect(page.locator(".floors-zone-setting").first()).toHaveText(
      /设定 [\d.]+ ℃风量 \d+%/,
    );
    await expect(page.locator(".floors-unserved")).toHaveCount(6);
    await expect(page.locator(".floors-temperature-band")).toHaveCount(6);
    await expect(page.locator(".floors-lift-table thead")).toContainText(
      "方向载重状态",
    );
    await assertShellScrolling(page, "Ops floors layout");
    expect(
      await page
        .locator(".floors-load-chart")
        .evaluate((e) => e.scrollHeight <= e.clientHeight + 1),
    ).toBe(true);
    const columns = await page
      .locator(".floors-page")
      .evaluate(
        (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length,
      );
    expect(columns).toBe(viewport.width < 640 ? 1 : 3);
    expect(
      await page
        .locator(".floors-page")
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    for (const region of await page
      .locator(".floors-lift-table-scroll")
      .all()) {
      expect(await region.evaluate((e) => getComputedStyle(e).overflowX)).toBe(
        "auto",
      );
    }
    const positions = () =>
      page
        .locator(".floors-lift-shaft")
        .evaluateAll((elements) =>
          elements.map((e) => Number(e.getAttribute("data-floor"))),
        );
    const day = opsDay("2026-10-12"),
      at = day.day_start_ms + 6000;
    const expected = evaluateOpsSnapshot(day, at).elevators;
    const initial = await positions();
    expected.forEach((lift, i) =>
      expect(Math.abs(initial[i] - lift.floor)).toBeLessThanOrEqual(0.05),
    );
    await page.reload();
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    await expect(page.locator(".floors-lift-shaft")).toHaveCount(
      expected.length,
    );
    (await positions()).forEach((floor, i) =>
      expect(Math.abs(floor - initial[i])).toBeLessThanOrEqual(0.05),
    );
    await page.getByRole("button", { name: "总览", exact: false }).click();
    await expect
      .poll(
        async () =>
          JSON.parse(
            (await page.locator(".twin-scene").getAttribute("data-scene")) ??
              "{}",
          ).opsAtMs,
        { timeout: 15000 },
      )
      .toBe(at);
    const scene = JSON.parse(
      (await page.locator(".twin-scene").getAttribute("data-scene"))!,
    );
    for (const lift of expected)
      expect(
        Math.abs(
          scene.elevators.find((row: { id: string }) => row.id === lift.id)
            .floor - lift.floor,
        ),
      ).toBeLessThanOrEqual(0.05);
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    await seekPageHour(page, 20);
    const selected = evaluateOpsSnapshot(
      day,
      day.day_start_ms + 20 * 3600000,
    ).elevators;
    await expect
      .poll(async () =>
        Math.max(
          ...(await positions()).map((floor, i) =>
            Math.abs(floor - selected[i].floor),
          ),
        ),
      )
      .toBeLessThanOrEqual(0.05);
    for (const text of await page
      .locator(".floors-lift-table tbody tr td:nth-child(3)")
      .allTextContents())
      expect(text).toMatch(/^\d+F$/);
    const rows = await page
      .locator(".floors-lift-table tbody tr")
      .evaluateAll((elements) =>
        elements.map((e) => ({
          load: Number(e.children[4].textContent?.replace("%", "")),
          status: e.children[5].textContent?.trim(),
        })),
      );
    for (const row of rows)
      expect(row.status).toBe(row.load >= 80 ? "满载" : "正常");
    expect(errors).toEqual([]);
  });
}
