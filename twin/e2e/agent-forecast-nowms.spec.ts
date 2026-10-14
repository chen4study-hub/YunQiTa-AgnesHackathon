import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import {
  assertDisplayText,
  forbiddenDisplayText,
} from "./agent-forecast-visible";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
])
  test.describe(`local-clock pages ${size.width}`, () => {
    test.use({
      viewport: size,
      deviceScaleFactor: size.dpr,
      timezoneId: "Asia/Shanghai",
    });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("playback crosses midnight, stops at t+24h and sends the current display_date", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      const requests: { origin: string; display_date: string }[] = [];
      await page.clock.install({ time: new Date("2026-10-12T23:30:00+08:00") });
      await page.clock.pauseAt(new Date("2026-10-12T23:30:00+08:00"));
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().endsWith("/chat/stream"))
          return route.abort();
        const body = route.request().postDataJSON();
        requests.push(body);
        return route.fulfill({
          contentType: "text/event-stream",
          body: [
            { type: "tool_start", tool: "forecast_peak", args: {} },
            {
              type: "tool_end",
              tool: "forecast_peak",
              summary: "峰值已查询",
              ms: 1,
            },
            {
              type: "answer_delta",
              text: `${body.display_date} 预测峰值。`,
            },
            { type: "done", known: true, grounded: true, needs_human: false },
          ]
            .map((e) => `data: ${JSON.stringify(e)}\n\n`)
            .join(""),
        });
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T23:30");
      await page.getByRole("button", { name: "预测与风险" }).click();
      await expect(page.locator(".forecast-root")).toHaveAttribute(
        "data-display-date",
        "2026-10-12 周一",
      );
      await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
      await page.clock.runFor(1000);
      await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
      await expect(page.getByLabel("当前本地日期")).toHaveText(
        "2026-10-13 周二",
      );
      await expect(page.locator(".forecast-root")).toHaveAttribute(
        "data-display-date",
        "2026-10-13 周二",
      );
      await expect(page.locator(".forecast-root")).toHaveAttribute(
        "data-current-t",
        /T00:00:/,
      );
      await page.locator(".forecast-details summary").first().click();
      await expect(
        page.getByRole("region", { name: "滚动预测数据表" }),
      ).toContainText("00:00");
      await expect(page.locator(".forecast-metric").first()).toContainText(
        "t · 00:00",
      );
      await expect(page.locator(".forecast-root")).not.toContainText(
        /后日|t · 次日|t · 昨日/,
      );
      await assertDisplayText(page);
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-display-date",
        "2026-10-13 周二",
      );
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-origin",
        /T00:00:/,
      );
      await expect(page.locator(".agent-record-card")).toContainText(
        "截至 00:00",
      );
      await expect(page.locator(".agent-record-card")).not.toContainText(
        /次日|后日/,
      );
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-decision-source",
        "replay",
      );
      await page.getByRole("textbox", { name: "运维问题" }).fill("峰值？");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(page.locator(".agent-answer-text").last()).toContainText(
        "2026-10-13",
      );
      expect(requests[0].display_date).toBe("2026-10-13");
      expect(requests[0].origin).toMatch(/^2017-.*T00:00:/);
      await assertDisplayText(page);
      await info.attach("after-midnight", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
      await page.clock.runFor(23100);
      await expect(
        page.getByRole("button", { name: "↺ 重置", exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel("当前本地时间")).toHaveText(
        "2026-10-13 周二 23:30:00",
      );
      await expect(page.locator(".agent-record-card")).toContainText(
        "截至 23:00",
      );
      await page.getByRole("button", { name: "↺ 重置", exact: true }).click();
      await expect(page.getByLabel("当前本地时间")).toHaveText(
        "2026-10-12 周一 23:30:00",
      );
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "次日",
      );
    });
  });
  });
test("22:30 playback at 02:11 uses the footer date for current, yesterday and next-day labels", async ({
  page,
}) => {
  test.setTimeout(30000);
  await page.clock.install({ time: new Date("2026-10-12T22:30:00+08:00") });
  await page.clock.pauseAt(new Date("2026-10-12T22:30:00+08:00"));
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T22:30");
  await page.getByRole("button", { name: "预测与风险" }).click();
  await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
  await page.clock.runFor(3700);
  await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
  await expect(page.getByLabel("当前本地日期")).toHaveText("2026-10-13 周二");
  await expect(page.locator(".forecast-metric").first()).toContainText(
    "t · 02:00",
  );
  await page.locator(".forecast-details summary").first().click();
  const table = page.getByRole("region", { name: "滚动预测数据表" });
  await expect(table.locator("tbody tr").nth(0).locator("th")).toHaveText(
    "01:00",
  );
  await expect(table.locator("tbody tr").nth(1).locator("th")).toHaveText(
    "02:00",
  );
  await expect(table).toContainText("次日 00:00");
  await expect(page.locator(".forecast-root")).not.toContainText(
    /后日|t · 次日/,
  );
  await page.getByRole("button", { name: "Agent 决策" }).click();
  await expect(page.locator(".agent-record-card")).toContainText("截至 02:00");
  await expect(page.locator(".agent-record-card")).toContainText("昨日 23:00");
  await expect(page.locator(".agent-record-card")).not.toContainText(
    /次日|后日/,
  );
  await assertDisplayText(page);
});

test("whitelist is restricted to the two exact model-card field names, never values or answers", async ({
  page,
}) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "预测与风险" }).click();
  await expect(page.locator(".forecast-model")).toBeVisible();
  await page.evaluate(() => {
    const root = document.querySelector(".forecast-model")!;
    root.insertAdjacentHTML(
      "beforeend",
      "<table><tr><th>节假日特征启用</th><td>今天是节假日场景</td></tr><tr><th>节假日路由</th><td>节假日路由</td></tr></table>",
    );
  });
  expect(await forbiddenDisplayText(page)).toEqual([
    "今天是节假日场景",
    "节假日路由",
  ]);
});
