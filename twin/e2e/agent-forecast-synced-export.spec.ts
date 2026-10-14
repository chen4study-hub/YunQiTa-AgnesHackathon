import { DESKTOP_125 } from "./viewport-profile";
import { test, expect, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { assertDisplayText } from "./agent-forecast-visible";
import { forecastView, rejectedSlots } from "../src/pages/forecast/data";
import { replayDecision } from "../src/pages/agent/data";
import type { ReplayData } from "../src/data/types";
const sizes = [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
];
const longDecimal = /(?<![\d.])[-+]?\d[\d,]*\.\d{2,}(?![\d.])/;
async function chartAudit(host: Locator) {
  await expect(host).toHaveAttribute("_echarts_instance_", /./);
  return host.evaluate(async (el) => {
    const moduleText = await (
      await fetch("/src/pages/forecast/Plot.tsx")
    ).text();
    const match = moduleText.match(
      /from\s+["']([^"']*\/echarts\.js[^"']*)["']/,
    )!;
    const lib = await import(match[1]);
    const chart = lib.getInstanceByDom(el),
      option = chart.getOption();
    const tooltip = option.tooltip[0],
      results: string[] = [];
    for (const s of option.series) {
      if (s.tooltip?.show === false) continue;
      for (let i = 0; i < (s.data?.length ?? 0); i++) {
        const raw = s.data[i],
          value = raw?.value ?? raw;
        if (typeof tooltip.formatter === "function")
          results.push(
            String(
              tooltip.formatter([
                { seriesName: s.name, dataIndex: i, value, data: raw },
              ]),
            ),
          );
        else if (typeof tooltip.valueFormatter === "function")
          results.push(
            String(
              tooltip.valueFormatter(Array.isArray(value) ? value[1] : value),
            ),
          );
      }
    }
    return {
      width: chart.getWidth(),
      height: chart.getHeight(),
      tooltips: results,
    };
  });
}
for (const size of sizes)
  test.describe(`synced export ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${size.width}x${size.height}@${size.dpr ?? 1}`, () => {
      test.use({ deviceScaleFactor: size.dpr ?? 1 });
      test("dense forecast windows, offline receipts and both pages remain clean", async ({
        page,
      }, info) => {
        test.setTimeout(90000);
        await page.route("**/api/**", (r) => r.abort());
        for (const scenario of ["normal", "peak", "abstain"]) {
          const data = JSON.parse(
            readFileSync(`public/replay/${scenario}.json`, "utf8"),
          ) as ReplayData;
          if (scenario === "normal")
            expect(
              data.hours.reduce(
                (n, h) => n + h.forecast_24h.filter((p) => p.abstain).length,
                0,
              ),
            ).toBe(164);
          const origin = data.hours.reduce(
            (best, h, i) =>
              h.forecast_24h.filter((p) => p.abstain).length >
              data.hours[best].forecast_24h.filter((p) => p.abstain).length
                ? i
                : best,
            0,
          );
          await page.goto(
            `/?source=file&scenario=${scenario}&at=2026-10-12T${String(origin).padStart(2, "0")}:00`,
          );
          await page.getByRole("button", { name: "预测与风险" }).click();
          const forecast = page.locator(".forecast-root");
          await expect(forecast).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          await expect(page.locator(".forecast-model")).toContainText(
            "负荷预测 v1 · 按楼每日校准",
          );
          await expect(page.locator(".forecast-model")).toContainText(
            "区间标称覆盖率",
          );
          await expect(
            page
              .locator(".forecast-model tr")
              .filter({ hasText: "区间标称覆盖率" }),
          ).toContainText("90.0%"); // cd9e4f7: one-decimal coverage
          await expect(page.locator(".forecast-model")).not.toContainText(
            "跨楼宇覆盖率",
          );
          await expect(page.locator(".forecast-model")).not.toContainText(
            "device_connected",
          );
          await expect(forecast).not.toContainText(/byron/i);
          await expect(forecast).toHaveAttribute("data-source", "contract-1.2");
          const risk = page.locator(".forecast-risk"),
            expected = rejectedSlots(forecastView(data, origin));
          await expect(risk).toContainText(`${expected.length} 个拒绝时段`);
          await page.screenshot({
            path: info.outputPath(`${scenario}-${size.width}-forecast-top.png`),
            fullPage: size.width === 390,
          });
          await risk.locator("summary").click();
          await risk.scrollIntoViewIfNeeded();
          await expect(risk.locator("tbody tr")).toHaveCount(expected.length);
          await assertDisplayText(page);
          const riskLayout = await risk.evaluate((e) => {
            const heading = e
                .querySelector(".forecast-heading")!
                .getBoundingClientRect(),
              details = e
                .querySelector(".forecast-details")!
                .getBoundingClientRect(),
              chart = e
                .querySelector(".forecast-confidence")!
                .getBoundingClientRect();
            return {
              headingBottom: heading.bottom,
              detailsTop: details.top,
              detailsBottom: details.bottom,
              chartTop: chart.top,
            };
          });
          expect(riskLayout.detailsTop).toBeGreaterThanOrEqual(
            riskLayout.headingBottom,
          );
          expect(riskLayout.chartTop).toBeGreaterThanOrEqual(
            riskLayout.detailsBottom - 1,
          );
          for (const card of await forecast.locator(".card").all()) {
            const m = await card.evaluate((e) => ({
              w: e.clientWidth,
              sw: e.scrollWidth,
              h: e.clientHeight,
              sh: e.scrollHeight,
            }));
            expect(m.sw - m.w).toBeLessThanOrEqual(1);
            expect(m.sh - m.h).toBeLessThanOrEqual(1);
          }
          expect(
            await forecast.evaluate((e) => e.scrollWidth - e.clientWidth),
          ).toBeLessThanOrEqual(1);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(size.width);
          for (const host of await forecast
            .locator(".forecast-plot[_echarts_instance_]")
            .all()) {
            const result = await chartAudit(host);
            expect(result.width).toBeGreaterThan(100);
            expect(result.height).toBeGreaterThanOrEqual(60);
            for (const text of result.tooltips) {
              expect(text).not.toMatch(longDecimal);
              expect(text).not.toMatch(
                /回放|模拟|估算|估计|推算|沿用|非实测|演示|游标|影子模式|待人工确认/,
              );
            }
          }
          await page.screenshot({
            path: info.outputPath(`${scenario}-${size.width}-forecast.png`),
            fullPage: size.width === 390,
          });
          if (expected.length)
            await expect(risk.locator("tbody tr").last()).toBeVisible();
          await page.getByRole("button", { name: /Agent 决策/ }).click();
          await expect(page.locator(".agent-root")).toBeVisible();
          await expect(page.locator(".agent-root")).not.toContainText(/byron/i);
          // A currently unrefused hour ensures the no-backend plan path is covered on each day.
          const index = data.hours.findIndex(
            (_, i) => !replayDecision(data, i).handoff,
          );
          if (index !== origin) {
            await page.goto(
              `/?source=file&scenario=${scenario}&at=2026-10-12T${String(index).padStart(2, "0")}:00`,
            );
            await page.getByRole("button", { name: /Agent 决策/ }).click();
          }
          await expect(page.locator(".agent-status-bar")).toContainText(
            "需要连接后端",
          );
          await expect(page.locator(".agent-decision-card")).not.toContainText(
            "0 条指令",
          );
          await expect(page.locator(".agent-decision-card")).not.toContainText(
            "回执暂无数据",
          );
          await assertDisplayText(page);
          for (const host of await page
            .locator(".agent-root .forecast-plot[_echarts_instance_]")
            .all()) {
            const results = await chartAudit(host);
            for (const text of results.tooltips) {
              expect(text).not.toMatch(longDecimal);
              expect(text).not.toMatch(
                /回放|模拟|估算|估计|推算|沿用|非实测|演示|游标|影子模式|待人工确认/,
              );
            }
          }
          await page
            .getByRole("button", { name: "查看执行回执", exact: true })
            .click();
          const receipt = page.getByRole("dialog", {
            name: "执行回执",
            exact: true,
          });
          await expect(receipt).toContainText("需要连接后端");
          await expect(receipt).not.toContainText(/0 条|暂无/);
          await expect(receipt.locator(".agent-server-receipt")).toHaveCount(0);
          await assertDisplayText(page);
          await page.screenshot({
            path: info.outputPath(
              `${scenario}-${size.width}-offline-receipt.png`,
            ),
          });
          await receipt.getByRole("button", { name: "关闭" }).click();
          await page.getByRole("button", { name: "展开调度理由" }).click();
          await assertDisplayText(page);
          await page.keyboard.press("Escape");
        }
      });
    });
  });
