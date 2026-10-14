import { test, expect } from "@playwright/test";
test("PageGrid changes columns, rows and named areas by container width", async ({
  page,
}) => {
  await page.goto("/e2e/fixtures/page-grid.html");
  const grid = page.locator(".page-grid");
  for (const [width, columns, areas] of [
    [1400, 3, '"a b c"'],
    [800, 2, '"a a" "b c"'],
    [390, 1, "none"],
  ] as const) {
    // Viewport remains desktop: the enclosing container alone drives the query.
    await page.locator("#container").evaluate((element, width) => {
      element.style.width = `${width}px`;
    }, width);
    await expect
      .poll(() =>
        grid.evaluate(
          (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
        ),
      )
      .toBe(columns);
    expect(
      await grid.evaluate((el) => getComputedStyle(el).gridTemplateAreas),
    ).toBe(areas);
    if (width === 390) {
      const boxes = await Promise.all(
        ["a", "b", "c"].map((a) =>
          page.locator(`[data-area="${a}"]`).boundingBox(),
        ),
      );
      expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
      expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
      const table = page.getByRole("region", {
        name: "滚动表格测试，可横向滚动",
      });
      expect(
        await table.evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      await table.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      expect(await table.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
  }
});
