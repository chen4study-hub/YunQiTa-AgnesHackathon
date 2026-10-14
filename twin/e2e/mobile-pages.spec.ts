import { isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";
import { test, expect } from "@playwright/test";
// Layout audits do not need unlimited rendering on the shared test machine.
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const name of ["楼层与电梯", "能源与告警"]) {
  test(`390x844 ${name}: readable text, compact donut, wrapping alarms and contained scrolling`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      const samples: { font: string; text: string }[] = [];
      (
        window as typeof window & { chartTextSamples: typeof samples }
      ).chartTextSamples = samples;
      CanvasRenderingContext2D.prototype.fillText = function (
        ...args: Parameters<typeof original>
      ) {
        if (this.canvas.closest(".floors-page,.energy-page"))
          samples.push({ font: this.font, text: String(args[0]) });
        return original.apply(this, args);
      };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?source=file&at=2026-10-12T14:00");
    await page.getByRole("button", { name }).click();
    const root = page.locator(
      name === "楼层与电梯" ? ".floors-page" : ".energy-page",
    );
    await expect(root.locator("[data-chart-id]").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const small = await root.evaluate((e) =>
      Array.from(e.querySelectorAll("*"))
        .filter(
          (n) =>
            Array.from(n.childNodes).some(
              (c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim(),
            ) &&
            n.getClientRects().length &&
            getComputedStyle(n).visibility !== "hidden",
        )
        .flatMap((n) => {
          const size = parseFloat(getComputedStyle(n).fontSize);
          return size < (n.classList.contains("type-unit") ? 10 : 11)
            ? [
                {
                  tag: n.tagName,
                  cls: n.className,
                  text: n.textContent?.slice(0, 45),
                  size,
                },
              ]
            : [];
        }),
    );
    expect(small).toEqual([]);
    const chartText = await page.evaluate(
      () =>
        (
          window as typeof window & {
            chartTextSamples: { font: string; text: string }[];
          }
        ).chartTextSamples,
    );
    expect(chartText.length).toBeGreaterThan(0);
    expect(
      chartText.filter(
        (s) => Number(s.font.match(/([\d.]+)px/)?.[1] ?? 0) < 11,
      ),
    ).toEqual([]);
    expect(
      await root.evaluate((e) => e.scrollWidth - e.clientWidth),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    if (name === "能源与告警") {
      const donut = await root.locator(".energy-donut").boundingBox();
      expect(donut!.width).toBeLessThanOrEqual(180);
      expect(donut!.height).toBeLessThanOrEqual(180);
      // The mobile legend is content-sized: one or more columns are valid if
      // every real Ops category stays inside the card without clipping.
      const legend = await root.locator(".energy-use-legend").evaluate((e) => {
        const card = e.closest("section")!.getBoundingClientRect();
        return Array.from(e.querySelectorAll("li")).map((item) => {
          const r = item.getBoundingClientRect();
          return {
            inside: r.left >= card.left - 1 && r.right <= card.right + 1,
            overflow: item.scrollWidth - item.clientWidth,
          };
        });
      });
      expect(legend.length).toBeGreaterThan(0);
      for (const item of legend) {
        expect(item.inside).toBe(true);
        expect(item.overflow).toBeLessThanOrEqual(1);
      }
      const heading = root.locator(".energy-alerts .energy-heading");
      await heading.scrollIntoViewIfNeeded();
      const title = await heading.locator("h2").boundingBox();
      expect(title!.width).toBeGreaterThan(80);
      expect(title!.height).toBeLessThan(32);
      const overflow = await root
        .locator(".energy-table-scroll")
        .evaluate((e) => ({
          x: getComputedStyle(e).overflowX,
          excess: e.scrollWidth - e.clientWidth,
        }));
      // Table-only horizontal scroll is allowed; main/document must still fit.
      expect(overflow.x).toBe("auto");
      await assertShellScrolling(page, `${name}/390`);
    } else {
      await expect(root.locator(".floors-load-chart")).toHaveAttribute(
        "data-bar-count",
        "40",
      );
      await assertShellScrolling(page, `${name}/390`);
    }
    await test.info().attach("mobile-layout", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
}
