import { expect, type Page } from "@playwright/test";

export const auditPages = [
  ["总览", "overview"],
  ["预测与风险", "forecast"],
  ["Agent 决策", "agent"],
  ["楼层与电梯", "floors"],
  ["能源与告警", "energy"],
  ["关于", "about"],
] as const;

export type CanvasText = { text: string; chart: string };
type AuditWindow = Window & {
  __canvasAudit: CanvasText[];
  __canvasAuditTarget?: string;
};

export async function installCanvasTextAudit(page: Page) {
  await page.addInitScript(() => {
    const w = window as AuditWindow;
    w.__canvasAudit = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (
      ...args: Parameters<typeof original>
    ) {
      const host = this.canvas.closest<HTMLElement>("[_echarts_instance_]");
      const chart =
        host?.getAttribute("aria-label") ||
        host?.className ||
        this.canvas.className ||
        "canvas";
      if (
        this.canvas.isConnected &&
        this.canvas.checkVisibility({ checkVisibilityCSS: true }) &&
        (!w.__canvasAuditTarget ||
          host?.dataset.auditChart === w.__canvasAuditTarget)
      ) {
        w.__canvasAudit.push({ text: String(args[0]), chart });
      }
      return original.apply(this, args);
    };
  });
}

export async function clearCanvasTextAudit(page: Page, target?: string) {
  await page.evaluate((target) => {
    const w = window as AuditWindow;
    w.__canvasAuditTarget = target;
    w.__canvasAudit = [];
  }, target);
}

export async function canvasTexts(page: Page) {
  return page.evaluate(() => (window as AuditWindow).__canvasAudit);
}

export async function visitAuditPage(page: Page, name: string, id: string) {
  await page.getByRole("button", { name, exact: false }).click();
  await expect(page.locator("main")).toHaveAttribute("data-page", id);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

// Initialized hosts cover all ECharts wrappers, including the bespoke Forecast/Floors ones.
export async function chartHosts(page: Page) {
  const candidates = page.locator(
    'main .echart:visible, main .forecast-plot[role="img"]:visible, main [_echarts_instance_]:visible',
  );
  for (let i = 0; i < (await candidates.count()); i++) {
    const host = candidates.nth(i);
    await host.scrollIntoViewIfNeeded();
    await expect(host).toHaveAttribute("_echarts_instance_", /.+/);
  }
  return page.locator("main [_echarts_instance_]:visible");
}
