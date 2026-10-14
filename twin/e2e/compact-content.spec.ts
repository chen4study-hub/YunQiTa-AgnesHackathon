import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => freezeTestHmr(page));

test("390 Agent: record cards show complete state and chat grows only to its content cap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/**", async (r) => {
    if (r.request().url().endsWith("/chat/stream"))
      return r.fulfill({ status: 404 });
    if (r.request().url().endsWith("/chat"))
      return r.fulfill({
        json: {
          known: true,
          grounded: true,
          answer: "已核对当前记录。".repeat(100),
          tool_trace: [],
        },
      });
    return r.abort();
  });
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "Agent 决策" }).click();
  await page.evaluate(() => document.fonts.ready);
  const rows = page.locator(".agent-record-card tbody tr");
  await expect(rows).toHaveCount(6);
  const geometry = await rows.evaluateAll((es) =>
    es.map((e) => {
      const cells = [...e.children].map((c) => ({
        text: c.textContent,
        rect: c.getBoundingClientRect().toJSON(),
      }));
      return {
        cells,
        rect: e.getBoundingClientRect().toJSON(),
        overflow: e.scrollWidth - e.clientWidth,
        display: getComputedStyle(e).display,
      };
    }),
  );
  for (const r of geometry) {
    expect(r.display).toBe("grid");
    expect(r.overflow).toBeLessThanOrEqual(1);
    for (const i of [0, 1, 3, 4])
      expect(r.cells[i].rect.bottom).toBeLessThanOrEqual(r.cells[2].rect.top);
    expect(r.cells[3].rect.right).toBeLessThanOrEqual(r.cells[4].rect.left);
    expect(r.cells[4].rect.right).toBeLessThanOrEqual(r.rect.right);
  }
  await expect(rows.first().locator(".agent-record-state")).toHaveText(
    "需要连接后端",
  );
  // Offline evidence cannot claim a successful manual takeover.
  await expect(page.getByRole("button", { name: "人工接管", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(rows.first().locator(".agent-record-state")).toHaveText("已撤销");
  expect(
    await rows.first().evaluate((e) => e.scrollWidth - e.clientWidth),
  ).toBeLessThanOrEqual(1);
  const card = page.locator(".agent-chat-card");
  const initial = await card.boundingBox();
  const messages = await page
    .locator(".agent-chat-messages")
    .evaluate((e) => ({ height: e.clientHeight, scroll: e.scrollHeight }));
  expect(messages.height).toBeLessThan(130);
  expect(messages.scroll - messages.height).toBeLessThanOrEqual(1);
  expect(initial!.height).toBeLessThan(420);
  await page.getByRole("textbox", { name: "运维问题" }).fill("查询记录");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".agent-answer-text")).toContainText(
    "已核对当前记录。",
  );
  const after = await card.boundingBox();
  expect(after!.height).toBeGreaterThan(initial!.height);
  expect(after!.height).toBeLessThan(700);
  expect(
    await page
      .locator(".agent-chat-messages")
      .evaluate((e) => e.scrollHeight > e.clientHeight),
  ).toBe(true);
});

async function forecast(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file");
  await page.getByRole("button", { name: "预测与风险" }).click();
  await page.evaluate(() => document.fonts.ready);
}

test("1366 Agent: reason control, dispatch step and candidate table fit", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await page.getByRole("button", { name: "Agent 决策" }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const preview = page.locator(".agent-reason-preview");
  await expect(preview).toBeVisible();
  const [plan, button, steps, last] = await Promise.all([
    page.locator(".agent-reason-section").boundingBox(),
    page.getByRole("button", { name: "展开调度理由" }).boundingBox(),
    page.locator(".agent-steps").boundingBox(),
    page
      .locator(".agent-steps > li:last-child")
      .boundingBox(),
  ]);
  expect(button!.y + button!.height).toBeLessThanOrEqual(
    plan!.y + plan!.height + 0.5,
  );
  expect(last!.y + last!.height).toBeLessThanOrEqual(
    steps!.y + steps!.height + 0.5,
  );
  for (const overflow of await page
    .locator(
      ".agent-reason-section,.agent-steps,.agent-comparison",
    )
    .evaluateAll((es) => es.map((e) => e.scrollHeight - e.clientHeight)))
    expect(overflow).toBeLessThanOrEqual(1);
  const table = page.getByRole("region", { name: "候选方案表", exact: true });
  const replay = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
  const count = replay.hours[14].agent.candidate_summaries.length;
  expect(count).toBeGreaterThanOrEqual(2);
  await expect(table.locator("tbody tr")).toHaveCount(count);
  const candidates = await table.evaluate((e) => ({
    width: e.scrollWidth - e.clientWidth,
    box: e.getBoundingClientRect().toJSON(),
    rows: [...e.querySelectorAll("tbody tr")].map((r) => r.getBoundingClientRect().toJSON()),
    fonts: [...e.querySelectorAll("th,td")].map((c) => parseFloat(getComputedStyle(c).fontSize)),
  }));
  expect(candidates.width).toBeLessThanOrEqual(1);
  for (const row of candidates.rows) {
    expect(row.top).toBeGreaterThanOrEqual(candidates.box.top);
    expect(row.bottom).toBeLessThanOrEqual(candidates.box.bottom);
    expect(row.right).toBeLessThanOrEqual(candidates.box.right);
  }
  for (const font of candidates.fonts) expect(font).toBeGreaterThanOrEqual(14);
  await assertShellScrolling(page, "1366 Agent intrinsic content");
  await page.getByRole("button", { name: "展开调度理由" }).click();
  await expect(
    page.getByRole("dialog", { name: "完整调度理由" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("1366 forecast model: both MAEs and mode fit the intrinsic card", async ({
  page,
}) => {
  await forecast(page);
  const geometry = await page.locator(".forecast-model").evaluate((e) => {
    const region = e.querySelector(".forecast-model-scroll")!;
    return {
      card: e.getBoundingClientRect().toJSON(),
      region: region.getBoundingClientRect().toJSON(),
      overflow: region.scrollHeight - region.clientHeight,
      widthOverflow: region.scrollWidth - region.clientWidth,
      rows: [...e.querySelectorAll("tbody tr")]
        .filter((r) => !r.closest("details"))
        .map((r) => ({
          text: r.textContent,
          rect: r.getBoundingClientRect().toJSON(),
        })),
    };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.widthOverflow).toBeLessThanOrEqual(1);
  for (const row of geometry.rows)
    expect(row.rect.bottom, row.text!).toBeLessThanOrEqual(
      geometry.region.bottom + 0.5,
    );
  for (const label of ["保留样本 MAE", "全样本 MAE", "运行模式"])
    await expect(
      page
        .locator(".forecast-model-scroll")
        .getByRole("rowheader", { name: label, exact: true }),
    ).toBeVisible();
  await page.locator(".forecast-model").scrollIntoViewIfNeeded();
  await assertShellScrolling(page, "1366 forecast model");
  await expect(page.locator(".forecast-model-details")).toHaveCount(0);
  expect(
    await page
      .locator(".forecast-model")
      .evaluate((e) => e.scrollHeight - e.clientHeight),
  ).toBeLessThanOrEqual(1);
  for (const size of await page
    .locator(".forecast-model-scroll th,.forecast-model-scroll td")
    .evaluateAll((es) =>
      es.map((e) => parseFloat(getComputedStyle(e).fontSize)),
    ))
    expect(size).toBeGreaterThanOrEqual(11);
});

test("1366 forecast metrics: hints below values without clipping", async ({
  page,
}) => {
  await forecast(page);
  for (const at of ["2026-10-12T14:00", "2026-07-23T14:00", "2026-10-01T14:00"]) {
    await page.goto(`/?source=file&at=${at}`);
    await page.getByRole("button", { name: "预测与风险" }).click();
    await page.waitForTimeout(400);
    const metrics = await page.locator(".forecast-metric").evaluateAll((es) =>
      es.map((e) => {
        const dd = e.querySelector("dd")!,
          hint = e.querySelector(":scope > small")!;
        const cell = e.getBoundingClientRect(),
          value = dd.getBoundingClientRect(),
          note = hint?.getBoundingClientRect();
        return {
          text: e.textContent,
          cell: cell.toJSON(),
          value: value.toJSON(),
          note: note?.toJSON() ?? null,
          size: parseFloat(getComputedStyle(dd).fontSize),
          glyph: dd
            .querySelector(".smooth-value")!
            .getBoundingClientRect()
            .toJSON(),
          overflow: e.scrollHeight - e.clientHeight,
          widthOverflow: e.scrollWidth - e.clientWidth,
        };
      }),
    );
    for (const m of metrics) {
      if (m.note) {
        expect(m.note.top, m.text!).toBeGreaterThanOrEqual(m.value.bottom - 0.5);
        expect(m.note.bottom, m.text!).toBeLessThanOrEqual(m.cell.bottom + 0.5);
        expect(m.note.top, m.text!).toBeGreaterThanOrEqual(m.glyph.bottom - 0.5);
      }
      expect(m.overflow, m.text!).toBeLessThanOrEqual(1);
      expect(m.widthOverflow, m.text!).toBeLessThanOrEqual(1);
      expect(m.size).toBe(24);
    }
    await assertShellScrolling(page, `forecast metrics ${at}`);
  }
});
