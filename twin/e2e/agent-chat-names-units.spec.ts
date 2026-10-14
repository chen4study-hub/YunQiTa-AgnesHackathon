import { test, expect } from "@playwright/test";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
for (const width of [1366, 390]) {
  test.describe(`names and units ${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 768 } });
    test("backend names appear in steps and tags; quantities stay together while the sentence wraps", async ({
      page,
    }, info) => {
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().endsWith("/chat/stream"))
          return route.abort();
        const events = [
          {
            type: "tool_start",
            tool: "tariff_periods",
            name: "分时电价与用电",
            args: {},
          },
          {
            type: "tool_end",
            tool: "tariff_periods",
            ms: 35.6,
            summary: "已核对电价",
          },
          {
            type: "tool_start",
            tool: "current_energy",
            name: "楼宇能源数据",
            args: {},
          },
          {
            type: "tool_end",
            tool: "current_energy",
            ms: 24.5,
            summary: "已核对能源",
          },
          { type: "tool_start", tool: "get_weather", args: {} },
          {
            type: "tool_end",
            tool: "get_weather",
            ms: 16.2,
            summary: "已核对天气",
          },
          {
            type: "answer_delta",
            text: "当前时段请按电价1.20 元/kWh核对，负荷为2.0 kW，电量为12.0 kWh，费用为30.0 元，温度为25.0 °C，比例为95.0 %，浓度为450 ppm，流量为1,200.0 m³/h，工具耗时35.6 ms，整轮耗时2.3 s，下一时段继续检查。",
          },
          { type: "done", known: true, grounded: true, needs_human: false },
        ];
        await route.fulfill({
          contentType: "text/event-stream",
          body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        });
      });
      await page.goto("/?source=file&scenario=normal&at=2026-10-13T14:00");
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await page.getByRole("textbox", { name: "运维问题" }).fill("核对电价");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "运维问题" }),
      ).toBeEnabled();
      await expect(
        page.locator('[data-tool="tariff_periods"] .agent-step-label'),
      ).toHaveText("分时电价与用电");
      await expect(
        page.locator('[data-tool="current_energy"] .agent-step-label'),
      ).toHaveText("楼宇能源数据");
      await expect(
        page.locator('[data-tool="get_weather"] .agent-step-label'),
      ).toHaveText("查询天气");
      await expect(page.locator(".agent-tool-tags code")).toHaveText([
        "分时电价与用电",
        "楼宇能源数据",
        "查询天气",
      ]);
      const answer = page.locator(".agent-answer-text");
      await expect(answer.locator(".agent-answer-quantity")).toHaveCount(10);
      // Deliberately narrow a paragraph so the sentence must wrap; never pin the whole answer.
      const layout = await answer.evaluate((el) => {
        const p = el.querySelector("p")!;
        p.style.width = "140px";
        const quantities = [
          ...el.querySelectorAll(".agent-answer-quantity"),
        ].map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return {
            text: node.textContent,
            lines: range.getClientRects().length,
            whiteSpace: getComputedStyle(node).whiteSpace,
          };
        });
        const paragraph = document.createRange();
        paragraph.selectNodeContents(p);
        return {
          quantities,
          paragraphLines: paragraph.getClientRects().length,
        };
      });
      for (const quantity of layout.quantities) {
        expect(quantity.lines, quantity.text!).toBe(1);
        expect(quantity.whiteSpace).toBe("nowrap");
      }
      expect(layout.paragraphLines).toBeGreaterThan(10);
      await answer.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath("names-units.png") });
      await page.reload();
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect(page.locator(".agent-tool-tags code")).toHaveText([
        "分时电价与用电",
        "楼宇能源数据",
        "查询天气",
      ]);
      await expect(page.locator(".agent-answer-quantity")).toHaveCount(10);
    });
  });
}
