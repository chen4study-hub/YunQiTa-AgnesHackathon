import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`readable type ${size.width}`, () => {
    test.setTimeout(90000);
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("all visible page text is at least 12px, body and tables respect page tokens", async ({
      page,
    }, info) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      for (const name of ["Agent 决策", "预测与风险"]) {
        await page.getByRole("button", { name }).click();
        const root = page.locator(
          name === "Agent 决策" ? ".agent-root" : ".forecast-root",
        );
        await expect(root).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const m = await root.evaluate((e) => {
          const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT),
            bad: any[] = [];
          let node;
          const sizes: number[] = [];
          while ((node = walker.nextNode())) {
            if (!node.textContent?.trim()) continue;
            const p = node.parentElement!;
            if (!p.getClientRects().length || p.closest("dialog:not([open])"))
              continue;
            const css = getComputedStyle(p);
            if (css.visibility === "hidden") continue;
            const size = parseFloat(css.fontSize);
            sizes.push(size);
            if (size < 12) bad.push({ text: node.textContent, size });
          }
          return {
            bad,
            min: Math.min(...sizes),
            tables: [...e.querySelectorAll("td")]
              .filter((n) => n.getClientRects().length)
              .map((n) => parseFloat(getComputedStyle(n).fontSize)),
            width: e.scrollWidth,
            client: e.clientWidth,
            body: getComputedStyle(e.querySelector("p")!).fontSize,
            bodyToken: parseFloat(getComputedStyle(e).getPropertyValue("--font-body")),
          };
        });
        console.log(
          JSON.stringify({
            width: size.width,
            page: name,
            min: m.min,
            body: m.body,
            tableMin: Math.min(...m.tables),
            bad: m.bad,
          }),
        );
        expect(m.bad).toEqual([]);
        expect(m.width).toBeLessThanOrEqual(m.client + 1);
        for (const s of m.tables) expect(s).toBeGreaterThanOrEqual(14);
        // 46f1724 already defines <=1366 CSS px as 14; DPR does not change CSS width.
        // Assert the token floor separately so a product token regression cannot pass.
        expect(m.bodyToken).toBe(size.width <= 1366 ? 14 : 15);
        expect(parseFloat(m.body)).toBeGreaterThanOrEqual(m.bodyToken);
        await page.screenshot({
          path: info.outputPath(
            name === "Agent 决策" ? "agent.png" : "forecast.png",
          ),
          fullPage: size.width === 390,
        });
      }
    });
  });
  });
