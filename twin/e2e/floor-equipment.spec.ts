import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createDataManifest } from "../scripts/dataManifest";
import { fileURLToPath } from "node:url";
import { seekPageHour } from "./page-seek";
import { floorsNumber } from "../src/pages/floors/numbers";
import { test, expect } from "@playwright/test";
import { opsDay, isolateOpsTest } from "./ops-test-data";
import { assertShellScrolling } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
]) {
  test(`${viewport.width}: all 40 floors fit and equipment floors have maintenance metrics`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?source=file&at=2026-07-23T14:00");
    await seekPageHour(page, 14);
    await page.getByRole("button", { name: "楼层与电梯" }).click();
    const root = page.locator(".floors-page");
    await expect(root).toHaveAttribute("data-time", "14");
    await page.evaluate(() => document.fonts.ready);
    const chart = root.locator(".floors-load-chart");
    await expect(chart).toHaveAttribute("data-bar-count", "40");
    // The added legend reduces the plot height; labels still use the same
    // collision-free adaptive stride while all 40 bars remain visible.
    const expectedStride = await chart.evaluate((el) =>
      Math.max(1, Math.ceil((40 * 14) / Math.max(1, el.clientHeight - 32))),
    );
    expect(Number(await chart.getAttribute("data-label-stride"))).toBe(
      expectedStride,
    );
    expect(expectedStride).toBeLessThanOrEqual(viewport.width === 1366 ? 3 : 2);
    for (const floor of [2, 39]) {
      await page
        .getByRole("combobox", { name: "选择楼层" })
        .selectOption(String(floor));
      await expect(root.locator(".floors-detail-card h2")).toHaveText(
        `${floor}F 设备层`,
      );
      await expect(
        root.locator(".floors-detail-card .floors-heading small"),
      ).toContainText("设备层运维");
      await expect(
        root.locator(".floors-detail-card .floors-heading small"),
      ).not.toContainText("6 个空间分区");
      const row = opsDay("2026-07-23").hours[14].floors.find(
        (row) => row.floor === floor,
      )!;
      for (const [label, value] of [
        ["在岗人数", floorsNumber(row.occupancy_people)],
        ["照明开启", floorsNumber(row.lighting_pct)],
        ["新风量", floorsNumber(row.fresh_air_m3_h)],
      ]) {
        const cell = root
          .locator(".floors-metrics > div")
          .filter({ has: page.getByText(label, { exact: true }) });
        await expect(cell.locator(".floors-number")).toHaveText(value);
      }
    }
    await assertShellScrolling(page, "Ops equipment floors");
    expect(
      await root
        .locator(".floors-unserved")
        .first()
        .evaluate((e) => getComputedStyle(e, "::after").content),
    ).toBe("none");
  });
}
test("exceeded temperature shows a positive red excess instead of negative distance", async ({
  page,
}) => {
  const root = new URL("../public/replay/", import.meta.url);
  const main = JSON.parse(readFileSync(new URL("peak.ops.json", root), "utf8"));
  const name = main.meta.floors_file;
  const data = JSON.parse(readFileSync(new URL(name, root), "utf8"));
  for (const hour of data.hours)
    for (const floor of hour.floors)
      if (floor.floor === 39) {
        floor.mean_temp_c = 28.1;
        for (const zone of floor.zones) zone.temp_c = 28.1;
      }
  const bytes = Buffer.from(JSON.stringify(data));
  main.meta.floors_sha256 = createHash("sha256").update(bytes).digest("hex");
  const mainBytes = Buffer.from(JSON.stringify(main));
  const manifest = await createDataManifest(fileURLToPath(root));
  for (const [file, body] of [
    [name, bytes],
    ["peak.ops.json", mainBytes],
  ] as const) {
    manifest.files[file] = {
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    };
    await page.route(
      (url) => url.pathname.endsWith("/replay/" + file),
      (route) => route.fulfill({ body, contentType: "application/json" }),
    );
  }
  await page.route(
    (url) => url.pathname.endsWith("/data-manifest.json"),
    (route) => route.fulfill({ json: manifest }),
  );
  await page.goto("/?source=file&at=2026-07-23T14:00");
  await seekPageHour(page, 14);
  await page.getByRole("button", { name: "楼层与电梯" }).click();
  await page.getByRole("combobox", { name: "选择楼层" }).selectOption("39");
  const note = page.locator(".floors-note");
  await expect(note.locator(".floors-over-limit")).toContainText(
    /超上限 \d\.\d ℃/,
  );
  await expect(note).not.toContainText("上限 -");
  expect(
    await note
      .locator(".floors-over-limit")
      .evaluate((e) => getComputedStyle(e).color),
  ).toBe("rgb(255, 77, 94)");
});
