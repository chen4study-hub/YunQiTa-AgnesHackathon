import { RESOURCE_LIMITED_LAUNCH } from "./viewport-profile";
test.use({ launchOptions: RESOURCE_LIMITED_LAUNCH });
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { OpsDay } from "../src/data/ops/model";
import { serveOps } from "./ops-fixture";
test.use({ timezoneId: "Asia/Shanghai" });
const billSelector = '.overview-metric:has-text("今日预计电费")';
for (const [date, scenario] of [
  ["2026-10-12", "normal"],
  ["2026-07-13", "peak"],
  ["2026-10-01", "abstain"],
])
  test(`overview bill derives from ops hourly prices ${scenario}`, async ({
    page,
  }) => {
    await page.route("**/api/**", (r) => r.abort());
    await serveOps(page);
    const main = JSON.parse(
      await readFile(
        new URL(`../../exports/replay/${scenario}.json`, import.meta.url),
        "utf8",
      ),
    );
    const ops: OpsDay = JSON.parse(
      await readFile(
        new URL(`../../exports/replay/${scenario}.ops.json`, import.meta.url),
        "utf8",
      ),
    );
    const cost = main.hours.reduce(
      (sum: number, h: { point_kw: number }, i: number) =>
        sum + h.point_kw * ops.meta.tariff.prices[i],
      0,
    );
    await page.goto(`/?source=file&scenario=${scenario}&at=${date}T18:31`);
    const bill = page.locator(billSelector);
    await expect(bill.locator("p")).toHaveText("峰时电价 1.20 元/kWh");
    await expect(bill.locator(".animated-number-text")).toHaveAttribute(
      "data-target",
      cost.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    );
  });
test("the label and bill both respond to changed ops prices rather than constants", async ({
  page,
}) => {
  await page.route("**/api/**", (r) => r.abort());
  await serveOps(page);
  const ops: OpsDay = JSON.parse(
    await readFile(
      new URL("../../exports/replay/normal.ops.json", import.meta.url),
      "utf8",
    ),
  );
  ops.meta.tariff.prices = ops.meta.tariff.prices.map((p) => p * 2);
  await serveOps(page, { "normal.ops.json": Buffer.from(JSON.stringify(ops)) });
  const main = JSON.parse(
    await readFile(
      new URL("../../exports/replay/normal.json", import.meta.url),
      "utf8",
    ),
  );
  const cost = main.hours.reduce(
    (sum: number, h: { point_kw: number }, i: number) =>
      sum + h.point_kw * ops.meta.tariff.prices[i],
    0,
  );
  await page.goto("/?source=file&at=2026-10-12T18:31");
  const bill = page.locator(billSelector);
  await expect(bill.locator("p")).toHaveText("峰时电价 2.40 元/kWh");
  await expect(bill.locator(".animated-number-text")).toHaveAttribute(
    "data-target",
    cost.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  );
});
test("missing ops prices show missing data instead of a hardcoded tariff", async ({
  page,
}) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.route(
    (url) => url.pathname.endsWith("/replay/ops-calendar.json"),
    (r) => r.fulfill({ status: 404, body: "" }),
  );
  await page.goto("/?source=file&at=2026-10-12T18:31");
  const bill = page.locator(billSelector);
  await expect(bill.locator("p")).toHaveText("电价数据缺失");
  await expect(bill.locator(".animated-number-text")).toHaveAttribute(
    "data-target",
    "—",
  );
});
