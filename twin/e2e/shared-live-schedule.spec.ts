import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { setTimelineHour } from "./timeline-helper";
for (const width of [390, 1366])
  test(`overview and Agent share different-from-replay current schedule ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    const peak = JSON.parse(readFileSync("public/replay/peak.json", "utf8"));
    const replay = peak.hours[14];
    expect(replay.agent.explanation_source).toBe("template");
    expect(replay.storage.power_kw).not.toBe(123.4);
    const requests: string[] = [];
    await page.route("**/api/**", async (route) => {
      if (!route.request().url().endsWith("/schedule")) return route.abort();
      const body = route.request().postDataJSON();
      requests.push(`${body.scenario}|${body.start}`);
      if (body.scenario !== "peak" || body.start !== replay.t)
        return route.fulfill({ status: 503, json: {} });
      const command = {
        timestamp: replay.t,
        hvac_setpoint_c: 25.5,
        battery_kw: 123.4,
        action: "execute",
      };
      await route.fulfill({
        json: {
          building_id: peak.meta.building_id,
          source: "rule",
          explanation_source: "template",
          selected: "rule_hold",
          plan: [command],
          candidates: [
            {
              candidate_id: "rule_hold",
              name: "实时保持方案",
              passed: true,
              plan: [command],
            },
          ],
          reason: "当前小时实时选择，储能 123.4 kW。",
          receipt: { count: 1, transport: "log_only", device_connected: false },
        },
      });
    });
    await page.goto("/?source=file&scenario=peak&at=2026-10-12T14:00");
    const body = page.locator(".agent-verdict .verdict-body");
    await expect(body).toHaveAttribute("data-decision-source", "schedule");
    await expect(body).toHaveAttribute("data-selected", "rule_hold");
    await expect(body).toHaveAttribute("data-battery-kw", "123.4");
    await expect(page.locator(".overview-decision-source")).toContainText(
      "规则决策",
    );
    await expect(page.locator(".overview-selected-plan")).toContainText(
      "实时保持方案",
    );
    await expect(page.locator(".overview-storage-power")).toContainText(
      "放电 123.4 kW",
    );
    await page
      .getByRole("button", { name: "Agent 决策", exact: false })
      .click();
    await expect(page.locator(".agent-root")).toHaveAttribute(
      "data-decision-source",
      "schedule",
    );
    await expect(page.locator(".agent-decision-source")).toHaveText(
      "规则决策",
    );
    await expect(
      page.locator(".agent-plan li").filter({ hasText: "EMS 储能" }),
    ).toContainText("放电 123.4");
    await expect(page.locator(".agent-selected")).toContainText("实时保持方案");
    await page.getByRole("button", { name: "总览", exact: false }).click();
    await expect(body).toHaveAttribute("data-battery-kw", "123.4");
    expect(requests.filter((key) => key === `peak|${replay.t}`)).toHaveLength(
      1,
    );
    await setTimelineHour(page, 13);
    await expect(page.locator(".timeline")).toHaveAttribute("data-time", "13");
    await expect(body).toHaveAttribute("data-decision-source", "replay");
    await setTimelineHour(page, 14);
    await expect(body).toHaveAttribute("data-decision-source", "schedule");
    expect(requests.filter((key) => key === `peak|${replay.t}`)).toHaveLength(
      1,
    );
    const overflow = await page
      .locator(".agent-verdict")
      .evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow).toBeLessThanOrEqual(1);
  });
