import { test, expect } from "@playwright/test";
test("all tabs preserve shell geometry and do not overflow horizontally", async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto("/?source=mock");
  await expect(page.locator(".twin-scene canvas")).toBeVisible();
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1440 },
    { width: 2560, height: 1080 },
    { width: 900, height: 1200 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(async () => (await page.locator(".dashboard").boundingBox())!.width)
      .toBeCloseTo(await page.evaluate(() => document.body.clientWidth), 1);
    await page.waitForTimeout(500);
    const bounds = async () =>
      Promise.all(
        [".dashboard", ".topbar", ".bottombar"].map((s) =>
          page.locator(s).boundingBox(),
        ),
      );
    const initial = await bounds();
    for (const name of [
      "预测与风险",
      "Agent 决策",
      "楼层与电梯",
      "能源与告警",
      "关于",
      "总览",
    ]) {
      await page.getByRole("button", { name, exact: false }).click();
      await page.waitForTimeout(300);
      const current = await bounds();
      for (let i = 0; i < initial.length; i++)
        for (const key of ["x", "y", "width", "height"] as const) {
          // Mobile is document-scroll: page length and footer position follow content.
          if (
            size.width <= 1180 &&
            (key === "height" || (i === 2 && key === "y"))
          )
            continue;
          expect(current[i]![key], `${name} ${key}`).toBeCloseTo(
            initial[i]![key],
            1,
          );
        }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      if (name !== "总览")
        await expect(page.locator(".overview-persistent")).toBeHidden();
    }
  }
});
