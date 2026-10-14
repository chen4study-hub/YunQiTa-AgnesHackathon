import { test, expect } from "@playwright/test";
import { currentUI4183 } from "./agent-local-ui-4183";
for (const width of [390, 1280])
  test(`both pages ${width} keep one decimal including .0 with real 4183 API`, async ({
    page,
  }, info) => {
    await currentUI4183(page);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 664 });
    await page.goto("/?scenario=normal&at=2026-10-13T14:00");
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(page.locator(".agent-root")).toHaveAttribute(
      "data-decision-source",
      "schedule",
      { timeout: 50000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator(".agent-plan-number .smooth-value")).toHaveCount(
      3,
    );
    expect(
      await page.locator(".agent-comparison tbody tr").count(),
    ).toBeGreaterThan(0);
    for (const metric of await page
      .locator(".agent-plan-number .smooth-value")
      .all())
      expect(await metric.getAttribute("aria-label")).toMatch(
        /^(?:(?:充电|放电|待机) )?[\d,]+\.\d$/,
      );
    for (const cell of await page
      .locator(
        ".agent-comparison tbody td:nth-child(2),.agent-comparison tbody td:nth-child(3),.agent-comparison tbody td:nth-child(4)",
      )
      .all())
      expect(
        await cell.locator(".smooth-value").getAttribute("aria-label"),
      ).toMatch(/^(?:(?:充电|放电|待机) )?[\d,]+\.\d$/);
    await page.screenshot({
      path: info.outputPath(`${width}-agent-decimal.png`),
    });
    await page.getByRole("button", { name: /预测与风险/ }).click();
    await expect(page.locator(".forecast-root")).toBeVisible();
    expect(
      await page.locator(".forecast-metric dd .smooth-value").count(),
    ).toBeGreaterThan(0);
    for (const value of await page
      .locator(".forecast-metric dd .smooth-value")
      .all()) {
      const text = await value.getAttribute("aria-label");
      if (/\d/.test(text ?? "")) expect(text).toMatch(/\d\.\d/);
    }
    await page.locator(".forecast-main summary").click();
    await expect(page.locator(".forecast-main table tbody tr")).toHaveCount(26);
    for (const cell of await page
      .locator(".forecast-main table tbody td:nth-child(3)")
      .all())
      expect((await cell.innerText()).trim()).toMatch(/^[\d,]+\.\d$/);
    const host = page.locator(".forecast-window-plot");
    const axes = await host.evaluate(async (el) => {
      const source = await (await fetch("/src/pages/forecast/Plot.tsx")).text();
      const url = source.match(
        /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
      )![1];
      const e = await import(url);
      const option = e.getInstanceByDom(el).getOption();
      return option.yAxis[0].axisLabel.formatter(1047);
    });
    expect(axes).toBe("1,047");
    await page.locator(".forecast-main summary").click();
    await page.screenshot({
      path: info.outputPath(`${width}-forecast-decimal.png`),
    });
  });
