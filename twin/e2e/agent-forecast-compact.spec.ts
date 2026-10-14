import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { DESKTOP_125 } from "./viewport-profile";
import { assertShellScrolling } from "./shell-scroll-policy";
import { test, expect } from "@playwright/test";

for (const viewport of [
  { width: 1366, height: 768 },
  DESKTOP_125,
  { width: 1920, height: 1080 },
  { width: 2560, height: 1080 },
  { width: 390, height: 844 },
]) {
  for (const tab of ["预测与风险", "Agent 决策"]) {
    test(`${tab} compact ${viewport.width}x${viewport.height}`, async ({
      page,
    }, info) => {
      test.setTimeout(60000);
      await page.setViewportSize(viewport);
      await page.route("**/api/**", (route) => route.abort());

      const root = page.locator(
        tab === "预测与风险" ? ".forecast-root" : ".agent-root",
      );
      for (const scenario of ["peak", "abstain", "normal"]) {
        await page.goto(
          `/?source=file&scenario=${scenario}&at=2026-10-12T14:00`,
          { waitUntil: "domcontentloaded" },
        );
        await page.getByRole("button", { name: tab }).click();
        await expect(root).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const hour = scenario === "abstain" ? 10 : 14;
        const slider = page.getByRole("slider", { name: "24 小时时间轴" });
        await slider.press("Home");
        for (let i = 0; i < Math.floor(hour / 6); i++)
          await slider.press("PageUp");
        for (let i = 0; i < hour % 6; i++) await slider.press("ArrowRight");
        await expect(slider).toHaveAttribute("aria-valuenow", String(hour));
        await page.waitForTimeout(650);
        const dimensions = await root.evaluate((e) => {
          const rect = e.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            height: e.clientHeight,
            scrollHeight: e.scrollHeight,
            width: e.clientWidth,
            scrollWidth: e.scrollWidth,
            cards: [...e.querySelectorAll("section.card")].filter(c => (c as HTMLElement).checkVisibility({checkVisibilityCSS: true})).map((c) => ({
              cls: c.className,
              rect: c.getBoundingClientRect().toJSON(),
              height: c.clientHeight,
              scrollHeight: c.scrollHeight,
            })),
            details: [
              ...e.querySelectorAll(
                ".forecast-plot,.agent-workflow-body,.forecast-metrics,.agent-actions",
              ),
            ].map((c) => ({
              cls: c.className,
              rect: c.getBoundingClientRect().toJSON(),
              height: c.clientHeight,
              scrollHeight: c.scrollHeight,
            })),
          };
        });
        await info.attach(`${scenario}-dimensions`, {
          body: JSON.stringify(dimensions),
          contentType: "application/json",
        });
        await info.attach(`${scenario}-screen`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(
          dimensions.width + 1,
        );
        if (viewport.width > 1180) {
          await assertShellScrolling(
            page,
            `${tab}/${scenario}/${viewport.width}`,
          );
          const selectors =
            tab === "Agent 决策"
              ? ".agent-actions:visible,.agent-record-card:visible,.agent-chat-form:visible"
              : ".forecast-key,.forecast-model,.forecast-risk,.forecast-floors";
          for (const box of await root
            .locator(selectors)
            .evaluateAll((es) =>
              es.map((e) => e.getBoundingClientRect().toJSON()),
            )) {
            expect(box.height).toBeGreaterThan(0);
          }
        } else {
          const cards = dimensions.cards;
          for (let i = 1; i < cards.length; i++)
            expect(cards[i].rect.top).toBeGreaterThanOrEqual(
              cards[i - 1].rect.bottom,
            );
        }
        if (tab === "Agent 决策") {
          // faa4164: missing/other whitespace must not pass as CSS spacing.
          for (const text of await root.locator(".agent-plan-number").allTextContents())
            expect(text).toMatch(/\d[ \u00a0](?:kW|°C)$/);
          await expect(root.locator(".agent-plan")).not.toContainText(
            "旧下发记录保留",
          );
          await expect(root.locator(".agent-steps li")).toHaveCount(6);
          await expect(root.locator(".agent-record-card tbody tr")).toHaveCount(
            6,
          );
          if (viewport.width > 1180 && scenario !== "abstain") {
            await root.getByRole("button", { name: "查看执行回执" }).click();
            const receipt = page.getByRole("dialog", { name: "执行回执" });
            await expect(receipt).toBeVisible();
            const bounds = await receipt.boundingBox();
            expect(bounds!.y).toBeGreaterThanOrEqual(0);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
              viewport.height,
            );
            await page.keyboard.press("Escape");
          }
          if (viewport.width === 390) {
            const fonts = await root
              .locator(
                ".agent-steps code,.agent-steps span,.agent-tag,.agent-tool-tags code,.agent-page table small",
              )
              .evaluateAll((es) =>
                es.map((e) => parseFloat(getComputedStyle(e).fontSize)),
              );
            for (const font of fonts) expect(font).toBeGreaterThanOrEqual(11);
            const targets = await root
              .locator(
                "button:visible,.agent-tag:visible,.agent-tool-tags code:visible",
              )
              .evaluateAll((es) =>
                es.map((e) => e.getBoundingClientRect().height),
              );
            for (const height of targets)
              expect(height).toBeGreaterThanOrEqual(36);
          }
        } else {
          const displayed = await root.locator(".forecast-metric dd").allTextContents();
          for (const text of displayed) {
            if (text.includes("%")) expect(text).toMatch(/\d[ \u00a0]%$/);
            if (text.includes("kW")) expect(text).toMatch(/\d[ \u00a0]kW$/);
          }
          const fonts = await root
            .locator(".forecast-model-scroll tbody td")
            .evaluateAll((es) => es.map((e) => getComputedStyle(e).fontSize));
          expect(new Set(fonts).size).toBe(1);
          const units = await root
            .locator(".forecast-unit")
            .evaluateAll((es) =>
              es.map(
                (e) =>
                  parseFloat(getComputedStyle(e).fontSize) /
                  parseFloat(getComputedStyle(e.parentElement!).fontSize),
              ),
            );
          if (viewport.width !== 390)
            for (const ratio of units) expect(ratio).toBeCloseTo(0.45, 1);
          else {
            for (const font of await root
              .locator(
                ".forecast-unit,.forecast-metric > small,.forecast-details summary",
              )
              .evaluateAll((es) =>
                es.map((e) => parseFloat(getComputedStyle(e).fontSize)),
              ))
              expect(font).toBeGreaterThanOrEqual(11);
            for (const height of await root
              .locator(".forecast-details summary")
              .evaluateAll((es) =>
                es.map((e) => e.getBoundingClientRect().height),
              ))
              expect(height).toBeGreaterThanOrEqual(36);
          }
        }
      }
    });
  }
}

test("390px unknown backend answer shows handoff and tool summary", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", async (route) => {
    if (route.request().url().endsWith("/chat/stream"))
      return route.fulfill({ status: 404 });
    if (!route.request().url().endsWith("/chat")) return route.abort();
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        grounded: true,
        known: false,
        answer: "不知道",
        origin: body.origin,
        tool_trace: [
          { tool: "get_forecast", result: {} },
          { tool: "compare_costs", result: {} },
        ],
      },
    });
  });
  await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "Agent 决策" }).click();
  await page.getByRole("textbox", { name: "运维问题" }).fill("设备故障原因？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const answer = page.locator(".agent-assistant").last();
  await expect(answer).toContainText("不知道");
  await expect(answer.locator(".agent-tool-tags code")).toHaveText([
    "负荷预测查询",
    "电费比较",
  ]);
  await expect(answer).not.toContainText("已转人工");
  for (const size of await answer
    .locator(".agent-tool-tags code")
    .evaluateAll((es) =>
      es.map((e) => ({
        font: parseFloat(getComputedStyle(e).fontSize),
        height: e.getBoundingClientRect().height,
      })),
    )) {
    expect(size.font).toBeGreaterThanOrEqual(11);
    expect(size.height).toBeGreaterThanOrEqual(36);
  }
});
