import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Locator } from "@playwright/test";
import { currentUI4183 } from "./agent-local-ui-4183";
// Never mutate a database during the ordinary e2e suite.
test.skip(
  process.env.AGENT_TAKEOVER_LIVE !== "1",
  "Explicit disposable-database opt-in required",
);
for (const width of [390, 1366]) {
  test(`live test database: ${width} panel, banner, receipt, history and cancellation`, async ({
    page,
  }, testInfo) => {
    expect(testInfo.project.use.baseURL).toBe(`http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4183}`);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
    await currentUI4183(page);
    // Keep the real 4183 API/database, optionally test the newly built UI without overwriting another owner's fixed deployment.
    if (process.env.AGENT_TAKEOVER_LOCAL_BUILD === "1")
      await page.route("http://127.0.0.1:4183/**", (route) => {
        const u = new URL(route.request().url());
        if (u.pathname.startsWith("/api/")) return route.continue();
        const root = path.resolve("dist"),
          file = path.resolve(
            root,
            "." +
              decodeURIComponent(
                u.pathname === "/" ? "/index.html" : u.pathname,
              ),
          );
        if (!file.startsWith(root + path.sep) || !existsSync(file))
          return route.continue();
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".woff2": "font/woff2",
        };
        return route.fulfill({
          body: readFileSync(file),
          contentType: types[path.extname(file)] ?? "application/octet-stream",
        });
      });
    const localNow = new Date(Date.parse(process.env.AGNES_TEST_CLOCK ?? new Date().toISOString()) + 8 * 3600000),
      date = localNow.toISOString().slice(0, 10),
      currentHour = localNow.getUTCHours();
    let hour = -1;
    for (let candidate = currentHour; candidate < 24; candidate++) {
      const response = await page.request.get(
        `/api/takeover/active?date=${date}&hour=${candidate}`,
      );
      expect(response.ok()).toBe(true);
      const candidateRecord = (await response.json()).takeover;
      if (
        !candidateRecord ||
        (candidateRecord.record_status ?? candidateRecord.status) !== "active"
      ) {
        hour = candidate;
        break;
      }
    }
    expect(
      hour,
      "An unoccupied disposable-db hour is needed",
    ).toBeGreaterThanOrEqual(0);
    await page.goto(
      `/?source=file&scenario=normal&at=${date}T${String(hour).padStart(2, "0")}:00`,
    );
    await page.getByRole("button", { name: /Agent 决策/ }).click();
    const inspect = async (area: Locator, name: string) => {
      await area.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`${width}-${name}.png`),
      });
      const metrics = await area.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          scroll: el.scrollHeight,
          client: el.clientHeight,
          overflow: getComputedStyle(el).overflowY,
          buttons: [...el.querySelectorAll("button")].map((b) => ({
            text: b.textContent,
            height: b.getBoundingClientRect().height,
            width: b.getBoundingClientRect().width,
          })),
          fonts: [...el.querySelectorAll("li, li span")].map((e) =>
            parseFloat(getComputedStyle(e).fontSize),
          ),
        };
      });
      const viewport = page.viewportSize()!;
      expect(metrics.x).toBeGreaterThanOrEqual(0);
      expect(metrics.width + metrics.x).toBeLessThanOrEqual(viewport.width);
      expect(
        metrics.buttons.every((b) => b.height >= 36 && b.width >= 36),
      ).toBe(true);
      expect(metrics.fonts.every((f) => f >= 13)).toBe(true);
      if (await area.evaluate((e) => e.tagName === "DIALOG")) {
        expect(metrics.y).toBeGreaterThanOrEqual(0);
        expect(metrics.height + metrics.y).toBeLessThanOrEqual(viewport.height);
        expect(metrics.overflow).toMatch(/auto|scroll/);
        await area.evaluate((e) => {
          e.scrollTop = e.scrollHeight;
        });
        await page.screenshot({
          path: testInfo.outputPath(`${width}-${name}-bottom.png`),
        });
        await area.evaluate((e) => {
          e.scrollTop = 0;
        });
      }
      console.log(name, JSON.stringify(metrics));
      await testInfo.attach(`${width}-${name}-metrics`, {
        body: JSON.stringify(metrics),
        contentType: "application/json",
      });
    };
    const schedules: any[] = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname === "/api/schedule" && response.ok())
        schedules.push(await response.json());
    });
    const assertRecords = async () => {
      if (width >= 1181)
        await page.getByRole("tab", { name: "近期记录（6 小时）" }).click();
      const rows = page.locator(".agent-record-card tbody tr");
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "需要连接后端",
      );
      const contents = await rows.evaluateAll((rs) =>
        rs.map((r) => [
          r.querySelector("th")!.textContent,
          ...[...r.querySelectorAll("td")]
            .slice(0, 2)
            .map((c) => c.textContent),
        ]),
      );
      const hourRow = rows.first();
      await expect(hourRow).not.toContainText("人工工单");
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "kW · 充电",
      );
      if (width >= 1181)
        await page.getByRole("tab", { name: "当前决策" }).click();
      return contents;
    };
    await expect(
      page.getByRole("button", { name: "人工接管", exact: true }),
    ).toBeEnabled();
    const exportedRows = await assertRecords();
    const actor = `Agnes自查-${width}-${Date.now()}`;
    await page.getByRole("button", { name: "人工接管", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "人工接管配置" });
    await panel.getByLabel("持续小时").fill("1");
    await panel.getByLabel("设定温度（°C）").fill("26");
    await panel.getByLabel("储能模式").selectOption("idle");
    await panel
      .getByLabel("原因", { exact: true })
      .fill("390/1366 布局自查，验收后立即撤销");
    await panel.getByLabel("操作人", { exact: true }).fill(actor);
    await inspect(panel, "panel");
    await panel.getByRole("button", { name: "提交接管" }).click();
    const banner = page.locator(".agent-takeover-banner");
    await expect(banner).toContainText(actor);
    await expect
      .poll(() => schedules.at(-1)?.status, { timeout: 50000 })
      .toBe("manual");
    await expect(page.locator(".agent-decision-source")).toHaveText("人工配置");
    try {
      const manualRows = await assertRecords();
      expect(manualRows[0].join(" ")).toContain(`人工接管 · 操作人 ${actor}`);
      await inspect(banner, "banner");
      await page.getByRole("button", { name: "查看执行回执" }).click();
      const receipt = page.getByRole("dialog", {
        name: "执行回执",
        exact: true,
      });
      await expect(receipt).toContainText("条指令");
      await inspect(receipt, "receipt");
      await receipt.getByRole("button", { name: "关闭" }).click();
      await page.getByRole("button", { name: "接管历史与日志" }).click();
      const history = page.getByRole("dialog", { name: "接管记录与日志" });
      await expect(history).toContainText(actor);
      await inspect(history, "history");
      await history.getByRole("button", { name: "关闭" }).click();
    } finally {
      const opened = page.locator("dialog[open]");
      if (await opened.count())
        await opened.getByRole("button", { name: "关闭" }).click();
      await banner.getByRole("button", { name: "撤销接管" }).click();
      const cancel = page.locator(".agent-takeover-cancel");
      await cancel
        .getByRole("textbox", { name: "撤销原因" })
        .fill("自查完成，恢复自动方案");
      const cancelActor = `${actor}-撤销`;
      await cancel
        .getByRole("textbox", { name: "撤销操作人", exact: true })
        .fill(cancelActor);
      await inspect(cancel, "cancel");
      const scheduleCount = schedules.length;
      await cancel.getByRole("button", { name: "确认撤销" }).click();
      await expect
        .poll(() => schedules.length, { timeout: 50000 })
        .toBeGreaterThan(scheduleCount);
      await expect
        .poll(() => schedules.at(-1)?.status, { timeout: 50000 })
        .toBe("executed");
      await testInfo.attach("post-cancel-schedule", {
        body: JSON.stringify(schedules.at(-1)),
        contentType: "application/json",
      });
      await expect(cancel).toHaveCount(0);
      await expect(page.locator(".agent-status-bar")).toContainText(
        "已自动下发 · 执行中",
      );
      await expect(page.locator(".agent-takeover-cancelled")).toContainText(
        cancelActor,
      );
      await page.waitForTimeout(2200);
      await expect(page.locator(".agent-root")).not.toContainText("人工接管中");
      await expect(page.locator(".agent-decision-source")).not.toHaveText(
        "人工配置",
      );
      await expect(
        page.locator(".agent-record-card tbody tr").first(),
      ).not.toContainText("人工接管 · 操作人");
      await page.reload();
      await page.getByRole("button", { name: /Agent 决策/ }).click();
      await expect
        .poll(() => schedules.at(-1)?.status, { timeout: 50000 })
        .toBe("executed");
      await expect(page.locator(".agent-takeover-cancelled")).toContainText(
        cancelActor,
      );
      await expect(page.locator(".agent-takeover-cancelled")).toContainText(
        "本小时人工接管已撤销",
      );
      const restoredRows = await assertRecords();
      expect(restoredRows.slice(1)).toEqual(exportedRows.slice(1));
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "人工工单",
      );
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "人工接管 · 操作人",
      );
      await inspect(
        page.locator(".agent-takeover-cancelled"),
        "cancelled-notice-after-reload",
      );
      await page.getByRole("button", { name: "接管历史与日志" }).click();
      const history = page.getByRole("dialog", { name: "接管记录与日志" });
      await expect(
        history.locator("article").filter({ hasText: actor }),
      ).toContainText("已撤销");
      await testInfo.attach("authoritative-schedule-responses", {
        body: JSON.stringify(
          schedules.map((s) => ({
            status: s.status,
            active_takeover: s.active_takeover?.id,
            origin: s.plan?.[0]?.timestamp,
          })),
        ),
        contentType: "application/json",
      });
      await inspect(history, "cancelled-history");
      await history.getByRole("button", { name: "关闭" }).click();
    }
  });
}
