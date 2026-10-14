import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { currentUI4183 } from "./agent-local-ui-4183";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
test.use({ viewport: DESKTOP_125, deviceScaleFactor: DESKTOP_125.dpr });
for (const scenario of ["normal", "peak", "abstain"])
  test(`${scenario} CSS1280x664 DPR1.25 tables, fonts, tooltip and dialogs`, async ({
    page,
  }, info) => {
    await currentUI4183(page);
    await page.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      (window as any).chartTexts = [];
      CanvasRenderingContext2D.prototype.fillText = function (
        ...args: Parameters<typeof original>
      ) {
        if (
          this.canvas.closest(".forecast-plot") &&
          (window as any).recordChart
        )
          (window as any).chartTexts.push({
            text: String(args[0]),
            font: this.font,
          });
        return original.apply(this, args);
      };
    });
    await page.goto(`/?scenario=${scenario}&at=2026-10-13T14:00`);
    await page.getByRole("button", { name: /预测与风险/ }).click();
    await expect(page.locator(".forecast-root")).toBeVisible();
    await expect(page.locator(".forecast-details summary")).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]),
    ).toEqual([1280, 664, 1.25]);
    async function audit(label: string) {
      const readings = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            ".forecast-table-scroll,.agent-table-scroll,.forecast-root,.agent-root,.agent-left-slot,.agent-chat-slot,dialog[open]",
          ),
        )
          .filter((e) => e.getClientRects().length)
          .map((e) => ({
            class: e.className,
            client: e.clientWidth,
            scroll: e.scrollWidth,
            clientHeight: e.clientHeight,
            scrollHeight: e.scrollHeight,
            overflowY: getComputedStyle(e).overflowY,
            overflow: getComputedStyle(e).overflowX,
            table: e.querySelector("table")?.getBoundingClientRect().width,
            rect: e.getBoundingClientRect().width,
          })),
      );
      console.log(label, JSON.stringify(readings));
      await info.attach(label, {
        body: JSON.stringify(readings),
        contentType: "application/json",
      });
      for (const r of readings)
        expect(
          r.scroll - r.client,
          `${label}: ${JSON.stringify(r)}`,
        ).toBeLessThanOrEqual(0);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    }
    for (const summary of await page.locator(".forecast-details summary").all())
      await summary.click();
    await audit("forecast-open-tables");
    await page.locator(".forecast-risk").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("forecast-tables.png") });
    const fontReadings = await page
      .locator(".forecast-root :is(th,td)")
      .evaluateAll((es) =>
        es
          .filter((e) => e.getClientRects().length)
          .map((e) => parseFloat(getComputedStyle(e).fontSize)),
      );
    expect(fontReadings.length).toBeGreaterThan(0);
    expect(Math.min(...fontReadings)).toBeGreaterThanOrEqual(14);
    for (const summary of await page.locator(".forecast-details summary").all())
      await summary.click();
    await page.locator(".forecast-root").evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: info.outputPath("forecast-top.png") });
    for (const selector of [
      ".forecast-window-plot",
      ".forecast-confidence-plot",
      ".forecast-floor-plot",
    ]) {
      const host = page.locator(selector);
      await host.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      const coord = await host.evaluate(async (el) => {
        const source = await (
          await fetch("/src/pages/forecast/Plot.tsx")
        ).text();
        const url = source.match(
          /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
        )![1];
        const e = await import(url);
        const chart = e.getInstanceByDom(el),
          o = chart.getOption();
        const axis = o.yAxis[0],
          formatted =
            typeof axis.axisLabel.formatter === "function"
              ? axis.axisLabel.formatter(1400)
              : "";
        (window as any).axisReading = {
          formatted,
          font: axis.axisLabel.fontSize,
          tooltipFont: o.tooltip[0].textStyle.fontSize,
        };
        const name = el.className;
        let series = 0,
          index = 2;
        if (name.includes("window"))
          series = o.series.findIndex((s: any) => s.id === "forecast-future");
        if (name.includes("floor")) index = 20;
        const value = o.series[series].data[index];
        return chart.convertToPixel(
          { seriesIndex: series },
          name.includes("confidence") ? [index, value.value] : value,
        );
      });
      expect(
        coord.every(Number.isFinite),
        `${selector}: ${JSON.stringify(coord)}`,
      ).toBe(true);
      await page.mouse.move(1, 1);
      await page.evaluate(() => {
        (window as any).chartTexts = [];
        (window as any).recordChart = true;
      });
      const box = (await host.boundingBox())!;
      await page.mouse.move(box.x + coord[0], box.y + coord[1], { steps: 2 });
      await page.waitForTimeout(500);
      const texts = await page.evaluate(() => (window as any).chartTexts);
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.some((t: any) => /\d\.\d(?: kW|%)/.test(t.text))).toBe(true);
      for (const t of texts) expect(t.text).not.toMatch(/\d\.\d{2,}/);
      const axes = await page.evaluate(() => (window as any).axisReading);
      expect(axes.font).toBeGreaterThanOrEqual(12);
      expect(axes.tooltipFont).toBeGreaterThanOrEqual(14);
      if (selector.includes("window")) expect(axes.formatted).toBe("1,400");
      await info.attach(selector.slice(1) + "-tooltip-texts", {
        body: JSON.stringify({ texts, axes }),
        contentType: "application/json",
      });
      await page.screenshot({
        path: info.outputPath(selector.slice(1) + "-tooltip.png"),
      });
      await page.evaluate(() => ((window as any).recordChart = false));
    }
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(page.locator(".agent-root")).toHaveAttribute(
      "data-decision-source",
      "schedule",
      { timeout: 50000 },
    );
    await audit("agent-layout");
    await page.locator(".agent-left-slot").evaluate((el) => {
      el.scrollTop = 0;
    });
    const agentFonts = await page
      .locator(".agent-root :is(th,td,button)")
      .evaluateAll((es) =>
        es
          .filter((e) => e.getClientRects().length)
          .map((e) => parseFloat(getComputedStyle(e).fontSize)),
      );
    expect(Math.min(...agentFonts)).toBeGreaterThanOrEqual(14);
    await page.screenshot({ path: info.outputPath("agent.png") });
    const scrolling = await page.locator(".agent-left-slot").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return { top: el.scrollTop, overflow: getComputedStyle(el).overflowY };
    });
    expect(scrolling.overflow).toBe("auto");
    expect(scrolling.top).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath("agent-bottom.png") });
    await page
      .getByRole("button", { name: "展开调度理由", exact: true })
      .click();
    await audit("agent-reason-dialog");
    await page.screenshot({ path: info.outputPath("agent-reason.png") });
    await page
      .getByRole("dialog", { name: "完整调度理由" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page
      .getByRole("button", { name: "查看执行回执", exact: true })
      .click();
    await audit("agent-receipt-dialog");
    await page.screenshot({ path: info.outputPath("agent-receipt.png") });
    await page
      .getByRole("dialog", { name: "执行回执" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await page
      .getByRole("button", { name: "接管历史与日志", exact: true })
      .click();
    await page.waitForTimeout(500);
    await audit("agent-history-dialog");
    await page.screenshot({ path: info.outputPath("agent-history.png") });
    await page
      .getByRole("dialog", { name: "接管记录与日志" })
      .getByRole("button", { name: "关闭", exact: true })
      .click();
  });
