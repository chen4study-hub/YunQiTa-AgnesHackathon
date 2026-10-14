import { DESKTOP_125 } from "./viewport-profile";
import { assertShellScrolling } from "./shell-scroll-policy";
import { test, expect } from "@playwright/test";

test.use({ viewport: DESKTOP_125, deviceScaleFactor: DESKTOP_125.dpr });
test("physical 1600x830 at 125% / CSS1280: Agent and forecast match other pages' right edges with readable main scrolling", async ({
  page,
}, info) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.evaluate(() => document.fonts.ready);
  const edges: Record<string, { right: number; bottom: number }> = {};
  for (const tab of [
    "总览",
    "楼层与电梯",
    "能源与告警",
    "预测与风险",
    "Agent 决策",
  ]) {
    await page.getByRole("button", { name: tab }).click();
    await page.waitForTimeout(400);
    edges[tab] = await page.locator("main").evaluate((main) => {
      const cards = [...main.querySelectorAll(".card")]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width && r.height);
      return {
        right: Math.max(...cards.map((r) => r.right)),
        bottom: Math.max(...cards.map((r) => r.bottom)),
      };
    });
    if (tab === "预测与风险" || tab === "Agent 决策") {
      expect(
        Math.abs(edges[tab].right - edges["总览"].right),
      ).toBeLessThanOrEqual(1);
      await assertShellScrolling(page, tab);
      await page.screenshot({ path: info.outputPath(`${tab}.png`) });
    }
  }
  for (const tab of ["楼层与电梯", "能源与告警"])
    expect(
      Math.abs(edges[tab].right - edges["总览"].right),
    ).toBeLessThanOrEqual(1);
  await info.attach("page-edges", {
    body: JSON.stringify(edges),
    contentType: "application/json",
  });
});
