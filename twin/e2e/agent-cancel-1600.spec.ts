import { DESKTOP_125 } from "./viewport-profile";
test.use({ deviceScaleFactor: DESKTOP_125.dpr });
import { test, expect } from "@playwright/test";
import { currentUI4183 } from "./agent-local-ui-4183";
test.skip(
  process.env.AGENT_TAKEOVER_LIVE !== "1",
  "Explicit disposable database opt-in",
);
test("physical 1600x830 at 125% / CSS1280 14:00 cancel shows execution at 0.8s and 2s without reload", async ({
  page,
}, info) => {
  expect(info.project.use.baseURL).toBe(`http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4183}`);
  await currentUI4183(page);
  await page.setViewportSize(DESKTOP_125);
  await page.goto("/?scenario=normal&at=2026-10-13T14:00");
  await page.getByRole("button", { name: /Agent 决策/ }).click();
  const actor = `Agnes1600-${Date.now()}`,
    responses: any[] = [];
  page.on("response", async (r) => {
    if (new URL(r.url()).pathname === "/api/schedule" && r.ok())
      responses.push(await r.json());
  });
  await page.getByRole("button", { name: "人工接管", exact: true }).click();
  const form = page.getByRole("dialog", { name: "人工接管配置" });
  await form.getByLabel("持续小时").fill("1");
  await form.getByLabel("设定温度（°C）").fill("26");
  await form.getByLabel("储能模式").selectOption("idle");
  await form.getByLabel("操作人", { exact: true }).fill(actor);
  let id = "";
  try {
    const write = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/takeover" &&
        r.request().method() === "POST",
    );
    await form.getByRole("button", { name: "提交接管" }).click();
    const created = await (await write).json();
    id = created.takeover.id;
    await expect(page.locator(".agent-takeover-banner")).toContainText(actor);
    await expect(page.locator(".agent-decision-source")).toHaveText(
      "人工配置",
      { timeout: 50000 },
    );
    await page.getByRole("button", { name: "撤销接管", exact: true }).click();
    await page
      .getByLabel("撤销原因", { exact: true })
      .fill("1600终验，恢复自动");
    const before = responses.length;
    await page.getByRole("button", { name: "确认撤销", exact: true }).click();
    await expect
      .poll(() => responses.length, { timeout: 50000 })
      .toBeGreaterThan(before);
    const samples: any[] = [];
    for (const wait of [800, 1200]) {
      await page.waitForTimeout(wait);
      const status = page.locator(".agent-status-bar");
      samples.push({
        delay: wait,
        header: await page.locator(".agent-decision-source").innerText(),
        count: await status.count(),
        visible: await status.isVisible(),
        text: (await status.count()) ? await status.innerText() : "",
        lifecycle: responses.at(-1)?.status,
        receipt: responses.at(-1)?.receipt,
      });
      await page.screenshot({ path: info.outputPath(`cancel-${wait}.png`) });
    }
    await info.attach("cancel-state-samples", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
    console.log(JSON.stringify(samples));
    for (const s of samples) {
      expect(s.count).toBe(1);
      expect(s.visible).toBe(true);
      expect(s.text).toContain("已自动下发 · 执行中");
    }
    await expect(page.locator(".agent-takeover-cancelled")).toContainText(
      actor,
    );
  } finally {
    if (id) {
      const history = await (
        await page.request.get(
          "/api/takeover/history?date=2026-10-13&limit=200",
        )
      ).json();
      const record = history.items.find((r: any) => r.id === id);
      if (record && !record.cancelled_at)
        await page.request.post(`/api/takeover/${id}/cancel`, {
          data: {
            operator_id: actor,
            reason: "终验清理",
            expected_version: record.version,
          },
        });
    }
  }
});
