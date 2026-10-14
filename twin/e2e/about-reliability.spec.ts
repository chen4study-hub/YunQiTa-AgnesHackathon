import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { freezeTestHmr, assertShellScrolling } from "./shell-scroll-policy";
import { formatNumber } from "../src/ui/numberFormat";
const paragraph =
  "预测可靠性按本楼前 10 天的误差每日更新，只用当天之前的数据。全年保留覆盖率由 90.4% 升至 90.7%，拒绝率由 16.2% 降至 15.8%。数据突变时仍需转人工；对低风险楼宇启用后，拒绝可能增多。";
for (const size of [
  { width: 390, height: 844 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test(`About reliability copy and file-backed metrics remain readable ${size.width}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await freezeTestHmr(page);
    await page.setViewportSize(size);
    await page.route("**/api/**", (route) => route.abort());
    const requests: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/replay/model_card.json")
        requests.push(req.url());
    });
    await page.goto("/?source=file&at=2026-10-12T14:00", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".dispatch-note")).toBeVisible();
    await expect(page.locator(".dispatch-note")).toContainText("整点调度");
    await expect(page.locator(".dispatch-note")).not.toContainText(
      /设备|日志记录|日志回执正常/,
    );
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(
      page.locator(".about-model p").filter({ hasText: paragraph }),
    ).toHaveText(paragraph);
    await expect(page.locator(".about-boundary")).toContainText(
      "候选方案的费用只比较可自动调度的时段，转人工时段不计入。",
    );
    await expect(page.locator(".architecture-details")).toContainText(
      "约束检查后记录日志回执；当前部署未接入现场设备。",
    );
    const card = JSON.parse(
      readFileSync("public/replay/model_card.json", "utf8"),
    );
    const percent = (v: unknown) =>
      typeof v === "number" ? `${formatNumber(v * 100)}%` : "未测量";
    const power = (v: unknown) =>
      typeof v === "number" ? `${formatNumber(v)} kW` : "未测量";
    await expect(page.locator(".about-metrics b")).toHaveText([
      percent(card.retained_coverage),
      "90%",
      percent(card.rejection_rate),
      power(card.retained_mae),
      power(card.all_sample_mae),
    ]);
    expect(requests).toHaveLength(1);
    await expect(page.locator(".model-version")).toHaveText(
      "负荷预测 v1 · 按楼每日校准",
    );
    await expect(page.locator(".about-model")).not.toContainText(
      /byron|跨建筑覆盖率|目标覆盖率/i,
    );
    await expect(page.locator(".about-rate-row").nth(1)).toContainText(
      "区间标称覆盖率",
    );
    await expect(page.locator(".about-rate-row").nth(1)).toContainText("90%");
    for (const name of [
      "总览",
      "预测与风险",
      "Agent 决策",
      "楼层与电梯",
      "能源与告警",
      "关于",
    ]) {
      await page.getByRole("button", { name, exact: false }).first().click();
      if (name === "关于") {
        await expect(page.locator(".about-correspondence")).toContainText("BDG2 Byron 楼 2017 年逐时实测");
        expect(await page.locator(".about-page > .card:not(.about-correspondence)").allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/byron/i)]));
      } else {
        await expect(page.locator("main")).not.toContainText(/byron/i);
      }
    }
    await assertShellScrolling(page, "About reliability");
    for (const card of await page.locator(".about-page > .card").all())
      expect(
        await card.evaluate(
          (el) =>
            el.scrollHeight <= el.clientHeight + 1 &&
            getComputedStyle(el).overflowY === "visible",
        ),
      ).toBe(true);
  });
}
