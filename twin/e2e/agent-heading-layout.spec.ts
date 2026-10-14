import { assertShellScrolling } from "./shell-scroll-policy";
import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 2560, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`headings ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${size.width}x${size.height}@${size.dpr ?? 1}`, () => {
      test.use({ deviceScaleFactor: size.dpr ?? 1 });
      test("title hierarchy, aligned counter and desktop geometry", async ({
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
            const r = e as HTMLElement,
              agent = !!r.querySelector(".agent-steps"),
              left = r.querySelector(".agent-left-slot") as HTMLElement;
            const titles = [...r.querySelectorAll(".card h2")]
              .filter((n) => n.getClientRects().length)
              .map((n) => ({
                text: n.textContent,
                size: parseFloat(getComputedStyle(n).fontSize),
              }));
            const chain = r
                .querySelector(".agent-chain")
                ?.getBoundingClientRect()
                .toJSON(),
              comparison = r
                .querySelector(".agent-comparison")
                ?.getBoundingClientRect()
                .toJSON();
            const rows = agent
              ? [...r.querySelectorAll(".agent-steps > li")].map((n) => {
                  const p = getComputedStyle(n, "::before");
                  return {
                    height: n.getBoundingClientRect().height,
                    counterPosition: p.position,
                    counterHeight: p.height,
                    align: getComputedStyle(n).alignItems,
                  };
                })
              : [];
            return {
              titles,
              chain,
              comparison,
              rows,
              scroll: r.scrollHeight,
              height: r.clientHeight,
              leftScroll: left?.scrollHeight,
              leftHeight: left?.clientHeight,
              overflow: [...r.querySelectorAll(".card")]
                .filter((n) => n.getClientRects().length)
                .map((n) => ({
                  cls: n.className,
                  diff: n.scrollWidth - n.clientWidth,
                })),
              sections: [...r.querySelectorAll(".forecast-page > .card")].map(
                (n) => ({
                  cls: n.className,
                  height: n.getBoundingClientRect().height,
                  scroll: n.scrollHeight,
                }),
              ),
              root: r.getBoundingClientRect().toJSON(),
            };
          });
          console.log(JSON.stringify({ width: size.width, page: name, ...m }));
          for (const t of m.titles) expect(t.size).toBeGreaterThanOrEqual(18);
          for (const o of m.overflow) expect(o.diff).toBeLessThanOrEqual(1);
          await assertShellScrolling(
            page,
            `${name}: main vertical scrolling allowed`,
          );
          if (name === "Agent 决策") {
            if (size.width >= 1600)
              expect(m.leftScroll).toBeLessThanOrEqual(m.leftHeight! + 1);
            if (size.width >= 1600) {
              expect(m.chain!.top).toBe(m.comparison!.top);
              expect(m.chain!.right).toBeLessThanOrEqual(m.comparison!.left);
            }
            for (const r of m.rows) {
              expect(r.counterPosition).toBe("static");
              expect(r.align).toBe("center");
            }
          }
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
