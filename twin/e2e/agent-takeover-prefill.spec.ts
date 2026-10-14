import { test, expect, TEST_BACKEND } from "./v2-test-backend";
import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { currentUI4183 } from "./agent-local-ui-4183";
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});
for (const edited of [false, true])
  test(`real test-database recommendation ${edited ? "clear/edit" : "untouched"} inputs submit then cancel`, async ({
    page,
  }, info) => {
    await currentUI4183(page);
    expect(info.project.use.baseURL).toBe(`http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 5227}`);
    await page.goto("/?scenario=normal&at=2026-10-13T14:00", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    await expect(
      page.getByRole("button", { name: "人工接管", exact: true }),
    ).toBeEnabled();
    const recommendation = await (
      await page.request.get(
        `${TEST_BACKEND}/takeover/recommendation?date=2026-10-13&hour=14`,
      )
    ).json();
    expect(recommendation.available).toBe(true);
    await page.getByRole("button", { name: "人工接管", exact: true }).click();
    const form = page.getByRole("dialog", { name: "人工接管配置" });
    const duration = form.getByLabel("持续小时"),
      temp = form.getByLabel("设定温度（°C）"),
      mode = form.getByLabel("储能模式");
    await expect(duration).toHaveValue(String(recommendation.duration_hours));
    await expect(temp).toHaveValue(String(recommendation.hvac_setpoint_c));
    await expect(mode).toHaveValue(recommendation.storage_mode);
    if (recommendation.storage_mode !== "idle")
      await expect(form.getByLabel("储能功率（kW）")).toHaveValue(
        String(recommendation.storage_power_kw),
      );
    const actor = `AgnesPrefill-${Date.now()}`;
    await form.getByLabel("操作人", { exact: true }).fill(actor);
    if (edited) {
      for (const input of [duration, temp]) {
        await input.fill("");
        await expect(input).toHaveValue("");
        await expect(input).toHaveAttribute("placeholder", /^推荐 /);
      }
      await mode.selectOption("");
      await expect(mode).toHaveValue("");
      await expect(mode.locator("option:checked")).toContainText("推荐：");
      if (recommendation.storage_mode !== "idle") {
        const power = form.getByLabel("储能功率（kW）");
        await power.fill("");
        await expect(power).toHaveValue("");
        await expect(power).toHaveAttribute("placeholder", /^推荐 /);
      }
      await duration.fill("1");
      await temp.fill("26");
      await mode.selectOption("charge");
      await form.getByLabel("储能功率（kW）").fill("40");
    }
    await page.screenshot({ path: info.outputPath("prefilled.png") });
    let id = "",
      version = 1;
    try {
      const post = page.waitForResponse(
        (r) =>
          /\/(?:api\/)?takeover$/.test(new URL(r.url()).pathname) &&
          r.request().method() === "POST",
      );
      await form.getByRole("button", { name: "提交接管" }).click();
      const response = await post;
      expect(response.ok()).toBe(true);
      const body = response.request().postDataJSON();
      const result = await response.json();
      id = result.takeover.id;
      version = result.takeover.version;
      expect(body).toMatchObject({
        hvac_setpoint_c: edited ? 26 : recommendation.hvac_setpoint_c,
        duration_hours: edited ? 1 : recommendation.duration_hours,
        storage_mode: edited ? "charge" : recommendation.storage_mode,
        storage_power_kw: edited ? 40 : recommendation.storage_power_kw,
      });
      await expect(page.locator(".agent-takeover-banner")).toContainText(actor);
      await expect(
        page.getByRole("button", { name: "撤销接管", exact: true }),
      ).toBeEnabled({ timeout: 60000 });
      await page.getByRole("button", { name: "撤销接管", exact: true }).click();
      await page
        .getByLabel("撤销原因", { exact: true })
        .fill("推荐预填验收完成，立即恢复自动");
      const cancelled = page.waitForResponse((r) =>
        r.url().endsWith(`/takeover/${id}/cancel`),
      );
      await page.getByRole("button", { name: "确认撤销", exact: true }).click();
      const cancellation = await (await cancelled).json();
      expect(cancellation.takeover.cancelled_at).toBeTruthy();
      await expect(page.locator(".agent-takeover-cancelled")).toContainText(
        actor,
      );
      await info.attach("takeover-write-cancel", {
        body: JSON.stringify({ recommendation, body, result, cancellation }),
        contentType: "application/json",
      });
    } finally {
      // Recover this test's write even if response observation failed before ID assignment.
      if (!id) {
        const history = await (await page.request.get(
          `${TEST_BACKEND}/takeover/history?date=2026-10-13&limit=200`,
        )).json();
        const own = history.items.find((r: any) => r.operator_id === actor);
        if (own) { id = own.id; version = own.version; }
      }
      if (id) {
        const history = await (
          await page.request.get(
            `${TEST_BACKEND}/takeover/history?date=2026-10-13&limit=200`,
          )
        ).json();
        const r = history.items.find((r: any) => r.id === id);
        expect(r).toBeTruthy();
        if (!r.cancelled_at) {
          const c = await page.request.post(`${TEST_BACKEND}/takeover/${id}/cancel`, {
            data: {
              operator_id: actor,
              reason: "预填验收清理",
              expected_version: r.version ?? version,
            },
          });
          expect(c.ok()).toBe(true);
        }
        const h = await (
          await page.request.get(
            `${TEST_BACKEND}/takeover/history?date=2026-10-13&limit=200`,
          )
        ).json();
        expect(h.items.find((r: any) => r.id === id).cancelled_at).toBeTruthy();
      }
    }
  });
