import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";
import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));
test("overview columns and all independent page skeletons", async ({
  page,
}, info) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await expect(page.locator(".overview-grid")).toBeVisible();
  const columns = await page
    .locator(".overview-grid")
    .evaluate((e) =>
      getComputedStyle(e).gridTemplateColumns.split(" ").map(Number.parseFloat),
    );
  expect(columns).toHaveLength(3);
  expect(columns[1]).toBeGreaterThan(columns[0]);
  expect(columns[1]).toBeGreaterThan(columns[2]);
  await expect(page.locator(".overview-left .overview-metric")).toHaveCount(4);
  await expect(page.locator(".scene-tools button")).toHaveCount(7);
  await expect(page.locator(".agent-verdict")).toContainText("整点调度");
  await page.goto("/?source=file&at=2026-10-01T10:00");
  await setTimelineHour(page, 10);
  await expect(page.locator(".model-status")).toHaveClass(/rejected/);
  await expect(page.locator(".agent-verdict")).toContainText("人工复核");
  await page.screenshot({ path: info.outputPath("overview-layout.png") });
  for (const [button, title] of [
    ["预测与风险", "24 小时负荷预测"],
    ["Agent 决策", "Agent 调度决策"],
    ["楼层与电梯", "电梯运行"],
    ["能源与告警", "告警与工单"],
    ["关于", "一栋塔楼，一个能源决策闭环"],
  ]) {
    await page.getByRole("button", { name: button, exact: false }).click();
    await expect(page.locator("main")).toContainText(title);
    await page.waitForTimeout(350);
    const text = await page.locator("main").innerText();
    // Business-page copy belongs to sessions A/B; this suite audits owned copy only.
    if (button === "关于")
      expect(text).not.toMatch(/模拟|估算|估计|示例|历史回放|回放/);
    await assertShellScrolling(page, `page skeleton ${button}`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      title,
    ).toBe(true);
  }
});
