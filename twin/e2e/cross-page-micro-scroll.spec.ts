import { DESKTOP_125 } from "./viewport-profile";
import { test, expect } from "@playwright/test";
import { auditPages, visitAuditPage } from "./canvas-text-audit";
import { freezeTestHmr, inspectShellScrolling } from "./shell-scroll-policy";

// Keep this six-page matrix independent of the old scene-label styling assertion.
for (const size of [
  { width: 1366, height: 768, scale: 1 },
  { ...DESKTOP_125, scale: DESKTOP_125.dpr },
  { width: 1920, height: 1080, scale: 1 },
  { width: 390, height: 844, scale: 1 },
]) {
  test.describe(`${size.width}x${size.height}@${size.scale}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
    });
    test.describe(`viewport ${(size).width}x${(size).height}@${(size).dpr ?? 1}`, () => {
    test.use({ deviceScaleFactor: (size).dpr ?? 1 });
    test("all six pages reject scrollbars caused by less than 8px overflow", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      await freezeTestHmr(page);
      await page.goto("/?source=file&at=2026-10-12T18:00");
      const violations: unknown[] = [],
        coverage: unknown[] = [];
      for (const [name, id] of auditPages) {
        await visitAuditPage(page, name, id);
        // Sample both the initial commit and settled layout; no 8px blind spot.
        for (const phase of ["initial", "settled"]) {
          if (phase === "settled") await page.waitForTimeout(500);
          const errors = await page.evaluate(inspectShellScrolling);
          violations.push(
            ...errors.map((error) => ({ page: name, phase, ...error })),
          );
          coverage.push({ page: name, phase, errors: errors.length });
        }
      }
      await info.attach("scroll-policy.json", {
        body: JSON.stringify({ size, coverage, violations }, null, 2),
        contentType: "application/json",
      });
      console.log("MICRO_SCROLL " + JSON.stringify({ size, violations }));
      expect(violations).toEqual([]);
    });
  });
  });
}
