import { DESKTOP_125 } from "./viewport-profile";
import { createHash } from "node:crypto";
import { replayDecision, elapsedMs } from "../src/pages/agent/data";
import { serveDataOverrides } from "./data-overrides-fixture";
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { formatPageNumber } from "../src/pages/displayNumbers";
const sizes = [
  { width: 1366, height: 768, dpr: 1 },
  DESKTOP_125,
  { width: 1920, height: 1080, dpr: 1 },
  { width: 390, height: 844, dpr: 1 },
];
const longDecimal = /(?<![\d.])[-+]?\d[\d,]*\.\d{2,}(?![\d.])/g;
async function audit(page: Page) {
  for (const root of [".forecast-root", ".agent-root"]) {
    const locator = page.locator(root);
    if (!(await locator.count())) continue;
    const text = (await locator.innerText()).replace(
      /\bv?\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/g,
      "[version]",
    );
    expect(text.match(longDecimal), text).toBeNull();
    const cells = await locator.locator("table td,table th").allTextContents();
    expect(
      cells.flatMap(
        (t) =>
          t.replace(/\bv?\d+\.\d+\.\d+\b/g, "[version]").match(longDecimal) ??
          [],
      ),
    ).toEqual([]);
  }
}
for (const size of sizes)
  test.describe(`page numbers ${size.width}`, () => {
    test.use({ viewport: size, deviceScaleFactor: size.dpr });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("all expanded tables and receipts have bounded grouped precision", async ({
      page,
    }, info) => {
      await page.route("**/api/**", (r) => r.abort());
      const files: Record<string, Buffer> = {};
      {
        const d = JSON.parse(readFileSync("public/replay/normal.json", "utf8"));
        for (const h of d.hours)
          h.agent.receipt = {
            ...h.agent.receipt,
            count: 2,
            elapsed_ms: [3.71, 0.936, 12.765, 1234.567, 9.5, 10][
              Number(h.t.slice(11, 13)) % 6
            ],
          };
        files["normal.json"] = Buffer.from(JSON.stringify(d));
        const detail = JSON.parse(
          readFileSync("public/replay/normal.agent-detail.json", "utf8"),
        );
        detail.main_sha256 = createHash("sha256")
          .update(files["normal.json"])
          .digest("hex");
        for (const h of d.hours)
          detail.hours[String(h.agent.detail_index)].agent.receipt =
            h.agent.receipt;
        files["normal.agent-detail.json"] = Buffer.from(JSON.stringify(detail));
      }
      {
        const card = JSON.parse(
          readFileSync("public/replay/model_card.json", "utf8"),
        );
        card.retained_mae = 42.651;
        files["model_card.json"] = Buffer.from(JSON.stringify(card));
      }
      await serveDataOverrides(page, files);
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T14:00");
      await page.getByRole("button", { name: "预测与风险" }).click();
      await expect(page.locator(".forecast-root")).toBeVisible();
      for (const summary of await page
        .locator(".forecast-details summary")
        .all())
        await summary.click();
      await expect(page.locator(".forecast-model")).toContainText("42.7 kW");
      const forecastTables = await page
        .locator(".forecast-root table")
        .allTextContents();
      await audit(page);
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-record-card tbody tr")).toHaveCount(6);
      const elapsed = await page
        .locator(".agent-record-card tbody tr td:last-child")
        .allTextContents();
      const fixture = JSON.parse(files["normal.json"].toString("utf8"));
      expect(elapsed.map((s) => s.trim())).toEqual(
        [14, 13, 12, 11, 10, 9].map((i) => {
          const d = replayDecision(fixture, i);
          return d.handoff ? "—" : elapsedMs(d.receipt.elapsed);
        }),
      );
      await page.getByRole("button", { name: "查看执行回执" }).click();
      await expect(
        page.getByRole("dialog", { name: "执行回执" }),
      ).toContainText("需要连接后端");
      await page.keyboard.press("Escape");
      await audit(page);
      await info.attach("number-audit.json", {
        body: JSON.stringify({ forecastTables, elapsed }),
        contentType: "application/json",
      });
    });
  });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("previous-day records survive playback and direct dawn; handoff has no execution latency", async ({
      page,
    }) => {
      test.setTimeout(60000);
      await page.clock.install({ time: new Date("2026-10-12T22:30:00") });
      await page.clock.pauseAt(new Date("2026-10-12T22:30:00"));
      await page.route("**/api/**", (r) => r.abort());
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T22:30");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      const before = await page
        .locator(".agent-record-card tbody tr")
        .allTextContents();
      await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
      await page.clock.runFor(1000);
      before.push(
        ...(await page
          .locator(".agent-record-card tbody tr")
          .allTextContents()),
      );
      await page.clock.runFor(2720);
      await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
      await expect(page.locator(".agent-root")).toHaveAttribute(
        "data-origin",
        /T02:00:/,
      );
      for (const hour of [21, 22, 23]) {
        const row = page
          .locator(".agent-record-card tbody tr")
          .filter({ hasText: `昨日 ${hour}:00` });
        await expect(row).toHaveCount(1);
        const old = before.find((s) => s.startsWith(`${hour}:00`))!;
        expect((await row.textContent())?.replace("昨日 ", "")).toBe(old);
      }
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "该时段记录未提供",
      );
      await audit(page);
      await page.goto("/?source=file&scenario=normal&at=2026-10-12T02:00");
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-record-card tbody tr")).toHaveCount(6);
      for (const hour of [21, 22, 23])
        await expect(page.locator(".agent-record-card tbody")).toContainText(
          `昨日 ${hour}:00`,
        );
      await expect(page.locator(".agent-record-card")).not.toContainText(
        "该时段记录未提供",
      );
      await audit(page);
      const d = JSON.parse(readFileSync("public/replay/abstain.json", "utf8"));
      const hour = d.hours.findIndex((h: { abstain: boolean }) => h.abstain);
      await page.goto(
        `/?source=file&scenario=abstain&at=2026-10-12T${String(hour).padStart(2, "0")}:00`,
      );
      await page.getByRole("button", { name: "Agent 决策" }).click();
      await expect(page.locator(".agent-handoff-summary")).toContainText(
        `风险评分 ${formatPageNumber(d.hours[hour].risk_score, "percent")}`,
      );
      const row = page.locator(".agent-record-card tbody tr").first();
      await expect(row).toContainText("待处理");
      await expect(row.locator("td").last()).toHaveText("—");
      await audit(page);
      await page.getByRole("button", { name: "预测与风险" }).click();
      for (const summary of await page
        .locator(".forecast-details summary")
        .all())
        await summary.click();
      await audit(page);
    });
  });
  });
