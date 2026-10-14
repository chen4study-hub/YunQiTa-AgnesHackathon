import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import type { OpsCalendar, OpsDay, OpsFloorsFile } from "../src/data/ops/model";
import { freezeTestHmr } from "./shell-scroll-policy";

export const OPS_DATES = {
  normal: "2026-10-12",
  peak: "2026-07-23",
  abstain: "2026-10-01",
} as const;
const json = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../public/replay/${name}`, import.meta.url), "utf8"),
  );
/** Read the same checked-in bytes as the file loader, including the split floors file. */
export function opsDay(date: string): OpsDay {
  const calendar: OpsCalendar = json("ops-calendar.json");
  const entry = calendar.days.find((row) => row.date === date);
  if (!entry) throw new Error(`Missing Ops calendar date: ${date}`);
  const day: OpsDay = json(`${entry.scenario}.ops.json`);
  day.day_start_ms = entry.day_start_ms;
  if (day.meta.floors_file) {
    const floors: OpsFloorsFile = json(day.meta.floors_file);
    for (const hour of day.hours) {
      const row = floors.hours.find((row) => row.offset_ms === hour.offset_ms);
      if (!row) throw new Error(`Missing Ops floors hour: ${hour.offset_ms}`);
      hour.floors = row.floors;
    }
  }
  return day;
}
export function exportedAlerts(day: OpsDay, hour: number) {
  return [
    ...day.work_orders.map((row) => ({ ...row, agent: true })),
    ...day.alerts.map((row) => ({ ...row, agent: false })),
  ]
    .filter((row) => row.offset_ms <= hour * 3600000)
    .sort(
      (a, b) => Number(b.agent) - Number(a.agent) || b.offset_ms - a.offset_ms,
    );
}
export async function assertOpsAlerts(page: Page, day: OpsDay, hour: number) {
  await expect
    .poll(async () =>
      page
        .locator(".energy-alert-table tbody tr[data-alert-id]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-alert-id")),
        ),
    )
    .toEqual(exportedAlerts(day, hour).map((row) => row.id));
}
export async function isolateOpsTest(page: Page) {
  await freezeTestHmr(page);
  await page.route("**/api/**", (route) => route.abort());
}
/** Resolve the token in the same inherited context, not by parsing clamp text. */
export async function assertTemperatureToken(page: Page) {
  const samples = await page
    .locator(".floors-temperature-value b")
    .evaluateAll((elements) =>
      elements.map((el) => {
        const probe = document.createElement("span");
        probe.style.fontSize = "var(--font-value-md)";
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        el.parentElement!.append(probe);
        const token = parseFloat(getComputedStyle(probe).fontSize);
        const actual = parseFloat(getComputedStyle(el).fontSize);
        probe.remove();
        const card = el.closest(".floors-zone")!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el.parentElement!);
        const rect = range.getBoundingClientRect();
        // Numeric and unit glyphs have different top edges at one baseline.
        // Count text fragments only: nested inline boxes are not extra lines.
        const walker = document.createTreeWalker(
          el.parentElement!,
          NodeFilter.SHOW_TEXT,
        );
        const rects: DOMRect[] = [];
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          range.selectNode(walker.currentNode);
          rects.push(
            ...Array.from(range.getClientRects()).filter((r) => r.width > 0),
          );
        }
        return {
          actual,
          token,
          fits: rect.left >= card.left - 1 && rect.right <= card.right + 1,
          singleLine:
            rects.length > 0 &&
            Math.max(...rects.map((r) => r.top)) <
              Math.min(...rects.map((r) => r.bottom)),
        };
      }),
    );
  expect(samples.length).toBeGreaterThan(0);
  for (const row of samples) {
    expect(row.token).toBeGreaterThanOrEqual(24);
    expect(row.token).toBeLessThanOrEqual(28);
    expect(row.actual).toBeGreaterThanOrEqual(row.token - 0.01);
    expect(row.fits).toBe(true);
    expect(row.singleLine).toBe(true);
  }
}
