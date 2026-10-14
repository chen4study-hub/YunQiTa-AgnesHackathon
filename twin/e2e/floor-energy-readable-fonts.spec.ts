import { DESKTOP_125 } from "./viewport-profile";
import { expect, test } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
import { seekPageHour } from "./page-seek";

test.beforeEach(async ({ page }) => freezeTestHmr(page));
for (const size of [
  { width: 1366, height: 768 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
])
  test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test(`visible DOM and canvas font floors ${size.width}`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    await page.setViewportSize(size);
    await page.addInitScript(() => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      (window as any).__fonts = [];
      CanvasRenderingContext2D.prototype.fillText = function (
        ...args: Parameters<typeof original>
      ) {
        const host = this.canvas.closest("[data-chart-id]");
        const samples = (window as any).__fonts as any[];
        if (host && String(args[0]).trim() && samples.length < 20000)
          samples.push({
            host: host.className,
            text: String(args[0]),
            font: this.font,
          });
        return original.apply(this, args);
      };
    });
    await page.goto("/?source=file&scenario=peak&at=2026-10-12T14:00");
    await seekPageHour(page, 14);
    for (const [label, selector] of [
      ["楼层与电梯", ".floors-page"],
      ["能源与告警", ".energy-page"],
    ]) {
      await page.getByRole("button", { name: label }).click();
      const root = page.locator(selector);
      await expect(root).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const audit = await root.evaluate((root, width) => {
        const rows: { text: string; size: number; minimum: number }[] = [];
        const clipping: string[] = [];
        // Audit each actual text node, not only container styles; include all scrollable content.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const el = node.parentElement!;
          if (
            !node.textContent?.trim() ||
            !el.checkVisibility({ checkVisibilityCSS: true })
          )
            continue;
          const range = document.createRange();
          range.selectNode(node);
          if (!range.getBoundingClientRect().width) continue;
          const unit = !!el.closest(".type-unit"),
            scale = !!el.closest(".floors-temperature-scale");
          rows.push({
            text: node.textContent.trim(),
            size: parseFloat(getComputedStyle(el).fontSize),
            minimum: unit || scale ? 12 : 14,
          });
        }
        for (const card of root.querySelectorAll("section")) {
          const cr = card.getBoundingClientRect();
          for (const child of card.children) {
            const r = child.getBoundingClientRect();
            if (r.bottom > cr.bottom + 1 || r.right > cr.right + 1)
              clipping.push(child.className);
          }
        }
        return {
          rows,
          clipping,
          body: parseFloat(getComputedStyle(root).fontSize),
          bodyMinimum: width > 1366 ? 15 : 14,
          horizontal: root.scrollWidth - root.clientWidth,
        };
      }, size.width);
      expect(audit.rows.length).toBeGreaterThan(30);
      expect(audit.body).toBeGreaterThanOrEqual(audit.bodyMinimum);
      expect(
        audit.rows.filter((r) => r.size < r.minimum),
        JSON.stringify(audit),
      ).toEqual([]);
      expect(audit.horizontal).toBeLessThanOrEqual(1);
      expect(audit.clipping).toEqual([]);
      const charts = root.locator("[data-chart-id]");
      const source = await (
        await page.request.get("/src/pages/energy/SmoothChart.tsx")
      ).text();
      const moduleUrl = source.match(
        /from ["']([^"']*echarts\.js[^"']*)["']/,
      )![1];
      const canvasAudit: {
        className: string;
        minimum: number;
        tooltipMinimum: number;
        height: number;
      }[] = [];
      for (let i = 0; i < (await charts.count()); i++) {
        const chart = charts.nth(i);
        await chart.scrollIntoViewIfNeeded();
        await page.evaluate(() => {
          (window as any).__fonts = [];
        });
        const option = await chart.evaluate(async (el, moduleUrl) => {
          const ec = await import(/* @vite-ignore */ moduleUrl);
          const instance = ec.getInstanceByDom(el);
          instance.getZr().refreshImmediately();
          const o = instance.getOption();
          instance.dispatchAction({
            type: "showTip",
            seriesIndex: 0,
            dataIndex: 0,
          });
          return {
            tooltip: o.tooltip[0].textStyle.fontSize,
            series: o.series.length,
          };
        }, moduleUrl);
        await page.waitForTimeout(200);
        const samples = await page.evaluate(
          () =>
            (window as any).__fonts as {
              font: string;
              text: string;
              host: string;
            }[],
        );
        expect(samples.length).toBeGreaterThan(0);
        const small = samples.filter(
          (s) => Number(s.font.match(/([\d.]+)px/)?.[1] ?? 0) < 12,
        );
        expect(small).toEqual([]);
        expect(option.tooltip).toBeGreaterThanOrEqual(13);
        // Real rich-text tooltip draws use two spaces between label and reading.
        const tooltip = samples.filter((s) => /  [-\d]/.test(s.text));
        expect(tooltip.length).toBeGreaterThan(0);
        for (const s of tooltip)
          expect(
            Number(s.font.match(/([\d.]+)px/)?.[1]),
          ).toBeGreaterThanOrEqual(13);
        const className = (await chart.getAttribute("class"))!;
        canvasAudit.push({
          className,
          minimum: Math.min(
            ...samples.map((s) => Number(s.font.match(/([\d.]+)px/)?.[1])),
          ),
          tooltipMinimum: Math.min(
            ...tooltip.map((s) => Number(s.font.match(/([\d.]+)px/)?.[1])),
          ),
          height: (await chart.boundingBox())!.height,
        });
        await chart.evaluate(async (el, moduleUrl) => {
          const ec = await import(/* @vite-ignore */ moduleUrl);
          ec.getInstanceByDom(el).dispatchAction({ type: "hideTip" });
        }, moduleUrl);
        if (
          selector === ".energy-page" &&
          !(await chart.getAttribute("class"))!.includes("donut")
        )
          expect((await chart.boundingBox())!.height).toBeGreaterThanOrEqual(
            size.width === 1366 ? 120 : size.width === 1600 ? 140 : 150,
          );
      }
      await info.attach(`${selector.slice(1)}-font-audit`, {
        body: JSON.stringify({ audit, canvasAudit }),
        contentType: "application/json",
      });
      console.log(
        size.width,
        label,
        JSON.stringify({
          DOMMinimum: Math.min(...audit.rows.map((r) => r.size)),
          body: audit.body,
          canvasAudit,
        }),
      );
      await root.evaluate((el) => {
        el.scrollTop = 0;
      });
      if (size.width === 390) await root.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: info.outputPath(`${selector.slice(1)}.png`),
      });
    }
  });
  });
