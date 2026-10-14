import { test, expect } from "@playwright/test";
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
test("mobile midnight date label is at least 12px and never overlaps hour text", async ({
  page,
}) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&at=2026-10-12T14:00");
  const label = page.locator(".timeline-date-label");
  await expect(label).toHaveText("10-12");
  const font = await label.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  );
  expect(font).toBeGreaterThanOrEqual(12);
  const date = await label.boundingBox(),
    hour = await page.locator(".mobile-hour-label").first().boundingBox();
  expect(date!.y).toBeGreaterThanOrEqual(hour!.y + hour!.height);
});
