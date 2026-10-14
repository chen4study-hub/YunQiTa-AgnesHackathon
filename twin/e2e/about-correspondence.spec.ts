import { test, expect } from "@playwright/test";
import { DESKTOP_125, RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
import { freezeTestHmr } from "./shell-scroll-policy";

test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });

const rows = [
  ["总负荷与气温", "来自 BDG2 Byron 楼 2017 年逐时实测，按日期类型对应到今天。"],
  ["24 小时预测与区间", "由模型输出，只用起报前的数据。"],
  ["楼层负荷", "将整栋负荷按 40 层用途和固定密度系数分摊。"],
  ["储能、光伏与电网购入", "按设备参数和规划结果计算。"],
  ["空调分区温度", "用线性热模型做舒适检查。"],
  ["BA/EMS 下发", "走日志接口，换成现场适配器就能接真实设备。"],
];
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
]) {
  test.describe(`correspondence ${size.width}x${size.height}@${size.dpr}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test("data provenance is readable without clipped content", async ({ page }, info) => {
      test.setTimeout(90000);
      await freezeTestHmr(page);
      await page.route("**/api/**", r => r.abort());
      await page.goto("/?source=file", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "关于", exact: false }).click();
      const card = page.locator(".about-correspondence");
      await expect(card).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(card.locator("h2")).toHaveText("虚实对应");
      await expect(card.locator("dt")).toHaveText(rows.map(r => r[0]));
      await expect(card.locator("dd")).toHaveText(rows.map(r => r[1]));
      await expect(page.locator(".about-page")).not.toContainText(/典型日|情景|模拟|估算|演示/);
      const metrics = await card.evaluate(el => {
        const root = getComputedStyle(document.documentElement);
        return { clipped: el.scrollHeight > el.clientHeight + 1,
          text: [...el.querySelectorAll("dt,dd")].map(e => ({
            minimum: parseFloat(root.getPropertyValue(e.tagName === "DT" ? "--font-note" : "--font-body")),
            size: parseFloat(getComputedStyle(e).fontSize), overflow: e.scrollWidth > e.clientWidth + 1 })) };
      });
      expect(metrics.clipped).toBe(false);
      for (const text of metrics.text) {
        expect(text.size).toBeGreaterThanOrEqual(text.minimum);
        expect(text.overflow).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const layout = await page.locator(".about-page").evaluate(root => {
        const rect = (selector: string) => {
          const r = root.querySelector(selector)!.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        return { model: rect(".about-model"), work: rect(".about-collaboration"),
          license: rect(".about-license"), correspondence: rect(".about-correspondence"),
          columns: getComputedStyle(root.querySelector(".about-correspondence-list")!).gridTemplateColumns.split(" ").length };
      });
      console.log(size.width, JSON.stringify(layout));
      if (size.width > 1180) {
        expect(layout.correspondence.left).toBeCloseTo(layout.work.left, 1);
        expect(layout.correspondence.right).toBeCloseTo(layout.license.right, 1);
        const gap = layout.correspondence.top - Math.max(layout.work.bottom, layout.license.bottom);
        expect(gap).toBeGreaterThanOrEqual(12);
        expect(gap).toBeLessThanOrEqual(32);
        expect(layout.columns).toBe(2);
        expect(Math.abs(layout.correspondence.bottom - layout.model.bottom)).toBeLessThan(32);
      } else {
        expect(layout.correspondence.top).toBeGreaterThan(layout.license.bottom);
        expect(layout.columns).toBe(1);
      }
      await page.locator("main").evaluate(el => { el.scrollTop = el.scrollHeight; });
      await page.screenshot({ path: info.outputPath("about-correspondence.png"), animations: "disabled" });
    });
  });
}
