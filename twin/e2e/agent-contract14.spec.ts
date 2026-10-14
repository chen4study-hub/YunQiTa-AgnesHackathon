import { DESKTOP_125 } from "./viewport-profile";
import { assertShellScrolling } from "./shell-scroll-policy";
import { replayWithAgentDetails } from "./replay-agent-fixture";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seekPageHour } from "./page-seek";
import {
  storagePower,
  storageLabel,
  storageMode,
} from "../src/pages/agent/data";
for (const size of [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
]) {
  test.describe(`contract 1.5 ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("three days: selection and wording badges follow replay, not LLM health", async ({
      page,
    }, info) => {
      await page.route("**/api/**", (route) => route.abort());
      for (const scenario of ["normal", "peak", "abstain"]) {
        const data = replayWithAgentDetails(scenario);
        await page.goto(
          `/?source=file&scenario=${scenario}&at=2026-10-12T14:00`,
        );
        await page.getByRole("button", { name: "Agent 决策" }).click();
        const a = data.hours[14].agent;
        const label = a.source === "llm" ? "LLM 决策" : "规则决策";
        await expect(page.locator(".agent-decision-source")).toHaveAttribute(
          "title",
          a.explanation_source === "template"
            ? "模板措辞"
            : a.explanation_source === "llm"
              ? "LLM 措辞"
              : "措辞来源未提供",
        );
        await expect(page.locator(".agent-decision-source")).toHaveText(label);
        await expect(page.locator(".agent-root")).toHaveAttribute(
          "data-origin",
          data.hours[14].t,
        );
        await page.evaluate(() => document.fonts.ready);
        await assertShellScrolling(
          page,
          "1.5 contract allows necessary main scrolling",
        );
        const tag = page.locator(".agent-decision-source");
        expect(
          await tag.evaluate((e) => e.scrollWidth - e.clientWidth),
        ).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: info.outputPath(`${scenario}.png`),
          fullPage: size.width === 390,
        });
      }
    });
  });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("schedule label retains same-hour replay wording when field is omitted and explicit wording overrides", async ({
      page,
    }) => {
      let explicit = false;
      const data = replayWithAgentDetails("peak");
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().endsWith("/schedule")) return route.abort();
        const body = route.request().postDataJSON();
        const h = data.hours.find((h: { t: string }) => h.t === body.start);
        const command = {
          timestamp: h.t,
          hvac_setpoint_c: 25.5,
          battery_kw: 0,
          action: "hold",
        };
        return route.fulfill({
          json: {
            building_id: data.meta.building_id,
            source: "llm",
            ...(explicit
              ? {
                  explanation_source:
                    h.agent.explanation_source === "llm" ? "template" : "llm",
                }
              : {}),
            plan: [command],
            candidates: [{ candidate_id: "rule_hold", plan: [command] }],
            selected: "rule_hold",
            reason: "已核验的接口理由。",
          },
        });
      });
      await page.goto("/?source=file&scenario=peak&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-decision-source",
        "schedule",
      );
      const a = data.hours[14].agent;
      await expect(page.locator(".agent-decision-source")).toHaveText(
        "LLM 决策",
      );
      await expect(page.locator(".agent-decision-source")).toHaveAttribute(
        "title",
        a.explanation_source === "llm" ? "LLM 措辞" : "模板措辞",
      );
      explicit = true;
      await seekPageHour(page, 13);
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-decision-source",
        "schedule",
      );
      const b = data.hours[13].agent;
      await expect(page.locator(".agent-decision-source")).toHaveText(
        "LLM 决策",
      );
      await expect(page.locator(".agent-decision-source")).toHaveAttribute(
        "title",
        b.explanation_source === "llm" ? "模板措辞" : "LLM 措辞",
      );
    });
  });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("charge and discharge remain signed in metrics, records and candidates", async ({
      page,
    }, info) => {
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      const data = replayWithAgentDetails("normal");
      for (const hour of [1, 10, 14]) {
        await seekPageHour(page, hour);
        const h = data.hours[hour],
          power = h.storage.power_kw;
        const metric = page.locator(".agent-plan li").last();
        // faa4164: textual separator, not a CSS margin; only U+0020/U+00A0.
        await expect.poll(async () =>
          ((await metric.locator(".agent-plan-number").textContent()) ?? "").replace(/\u00a0/g, " "),
        ).toBe(`${storageLabel(power)} kW`);
        await expect(
          metric.locator(".agent-plan-number .smooth-value"),
        ).toHaveText(storageLabel(power));
        await expect(
          metric.locator(".agent-plan-number .smooth-value"),
        ).toContainText(storageMode(power));
        expect(
          (
            await page
              .locator(".agent-record-card tbody tr")
              .first()
              .innerText()
          ).replace(/\u00a0/g, " "),
        ).toContain(storagePower(power));
        for (const [i, c] of h.agent.candidates.entries()) {
          const p = c.plan.find(
            (p: { timestamp: string }) =>
              Date.parse(p.timestamp) === Date.parse(h.t),
          );
          await expect(
            page.locator(".agent-candidate-storage").nth(i),
          ).toContainText(storageLabel(p.battery_kw));
          await expect(
            page.locator(".agent-candidate-storage").nth(i),
          ).toContainText(storageMode(p.battery_kw));
        }
        await page.waitForTimeout(350);
        await assertShellScrolling(
          page,
          "1.5 contract allows necessary main scrolling",
        );
        await page.screenshot({
          path: info.outputPath(`storage-${hour}.png`),
          fullPage: size.width === 390,
        });
      }
    });
  });
  });
}
