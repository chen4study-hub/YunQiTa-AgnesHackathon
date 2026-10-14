import { expect, test } from "@playwright/test";
for (const width of [390, 1366, 1920])
  test(`${width}: floor legend hides only percentile text on narrow screens`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width,
      height: width === 390 ? 844 : width === 1366 ? 768 : 1080,
    });
    await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
    await page
      .getByRole("button", { name: "楼层与电梯", exact: false })
      .click();
    const legend = page.locator(".floors-load-legend");
    for (const [index, p] of [10, 50, 90].entries()) {
      await expect(legend.locator(":scope > span").nth(index)).toHaveAttribute(
        "title",
        new RegExp(`p${p}.*kW`),
      );
      await expect(legend.locator(":scope > span").nth(index)).toContainText(
        "kW",
      );
    }
    const text = await legend.innerText();
    for (const word of ["低", "中", "高", "设备层"])
      expect(text).toContain(word);
    if (width <= 1600) expect(text).not.toMatch(/p10|p50|p90/);
    else expect(text).toMatch(/p10/);
    expect(
      await legend.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    if (width > 640)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight + 1,
        ),
      ).toBe(true);
  });
