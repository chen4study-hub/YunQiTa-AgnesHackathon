import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`forecast target gate ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("same target keeps its gate across playback origins; count, table and red regions agree", async ({
      page,
    }) => {
      test.setTimeout(60000);
      await page.clock.install({ time: new Date("2026-10-12T22:30:00") });
      await page.clock.pauseAt(new Date("2026-10-12T22:30:00"));
      await page.route("**/api/**", (r) => r.abort());
      const data = JSON.parse(
        readFileSync("public/replay/normal.json", "utf8"),
      );
      const rejected = data.hours.filter(
        (h: { abstain: boolean }) => h.abstain,
      ).length;
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T22:30");
      await page.getByRole("button", { name: "预测与风险" }).click();
      await page.locator(".forecast-details summary").first().click();
      let before: Record<string, boolean> = {};
      for (let step = 0; step < 4; step++) {
        const rows = await page.locator("tr[data-slot-t]").evaluateAll((es) =>
          es.map((el) => ({
            t: el.getAttribute("data-slot-t")!,
            gate: el.getAttribute("data-realized-abstain") === "true",
            status: el.querySelector("td:last-child")!.textContent,
          })),
        );
        expect(rows).toHaveLength(24);
        for (const row of rows) {
          expect(row.gate).toBe(
            data.hours[Number(row.t.slice(11, 13))].abstain,
          );
          expect(row.status).toBe(row.gate ? "拒绝 · 转人工" : "可信");
          if (row.t.slice(11, 16) in before)
            expect(row.gate).toBe(before[row.t.slice(11, 16)]);
        }
        before = {
          ...before,
          ...Object.fromEntries(rows.map((r) => [r.t.slice(11, 16), r.gate])),
        };
        await expect(
          page.locator(".forecast-risk .forecast-heading"),
        ).toContainText(`${rejected} 个拒绝时段`);
        const red = await page
          .locator(".forecast-window-plot")
          .evaluate(async (el) => {
            const module = await (
              await fetch("/src/pages/forecast/Plot.tsx")
            ).text();
            const url = module.match(
              /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
            )![1];
            const echarts = await import(url);
            const option = echarts.getInstanceByDom(el).getOption();
            return option.series.find((s: any) => s.id === "forecast-future")
              .markArea.data.length;
          });
        expect(red).toBe(rejected);
        if (step === 0)
          await page
            .getByRole("button", { name: "▶ 播放", exact: true })
            .click();
        if (step < 3) await page.clock.runFor(1000);
      }
      await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
    });
  });
  });
