import { assertShellScrolling, freezeTestHmr } from "./shell-scroll-policy";
import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";
// Layout audits do not need unlimited rendering on the shared test machine.
test.beforeEach(async ({ page }) => freezeTestHmr(page));
test.use({ viewport: { width: 390, height: 844 } });
test("390px shell text and every About touch target meet minimums", async ({
  page,
}) => {
  await page.goto("/?source=mock&at=2026-10-01T14:00");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".twin-scene canvas")).toBeVisible();
  await expect(page.locator(".brand span")).toBeVisible();
  for (const selector of [
    ".brand span",
    ".mobile-hour-label",
    ".footer-details-toggle",
  ]) {
    const sizes = await page
      .locator(selector)
      .evaluateAll((es) =>
        es.map((el) => parseFloat(getComputedStyle(el).fontSize)),
      );
    expect(
      sizes.every((size) => size >= 12),
      selector,
    ).toBe(true);
  }
  await expect(page.locator(".nav-item small").first()).toBeHidden();
  for (const [name, id] of [
    ["总览", "overview"],
    ["预测与风险", "forecast"],
    ["Agent 决策", "agent"],
    ["楼层与电梯", "floors"],
    ["能源与告警", "energy"],
    ["关于", "about"],
  ]) {
    await page.getByRole("button", { name, exact: false }).click();
    await expect(page.locator("main")).toHaveAttribute("data-page", id);
    const failures = await page
      .locator(".topbar,.bottombar")
      .evaluateAll((roots) =>
        roots.flatMap((root) =>
          [...root.querySelectorAll<HTMLElement>("*")]
            .filter(
              (el) =>
                el.checkVisibility({ checkVisibilityCSS: true }) &&
                [...el.childNodes].some(
                  (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
                ) &&
                parseFloat(getComputedStyle(el).fontSize) < 10,
            )
            .map((el) => ({
              tag: el.tagName,
              cls: el.className,
              size: getComputedStyle(el).fontSize,
            })),
        ),
      );
    expect(failures, name).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      name,
    ).toBe(true);
  }
  const smallTargets = await page
    .locator(".topbar,.bottombar,.about-page")
    .evaluateAll((roots) =>
      roots.flatMap((root) =>
        [
          ...root.querySelectorAll<HTMLElement>(
            'button,a[href],input,select,textarea,[role="button"]',
          ),
        ]
          .filter(
            (el) =>
              !el.hasAttribute("inert") &&
              el.checkVisibility({ checkVisibilityCSS: true }),
          )
          .map((el) => ({
            text: el.getAttribute("aria-label") || el.textContent?.trim(),
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
          }))
          .filter((el) => el.width < 36 || el.height < 36),
      ),
    );
  expect(smallTargets).toEqual([]);
  const links = await page.locator(".about-license a").count();
  expect(links).toBe(3);
});
test("compact shell, 24-cell touch timeline, scene first and content-sized verdict", async ({
  page,
}) => {
  await page.goto("/?source=mock&at=2026-10-01T14:00");
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".twin-scene canvas")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const top = (await page.locator(".topbar").boundingBox())!;
  expect(top.height).toBeLessThan(150);
  await expect(page.locator(".nav-item small").first()).toBeHidden();
  const logo = (await page.locator(".top-logo").boundingBox())!,
    day = (await page.getByLabel("当前本地日期").boundingBox())!;
  // The read-only date is shorter than the logo; the grid aligns their centers.
  expect(
    Math.abs(logo.y + logo.height / 2 - day.y - day.height / 2),
  ).toBeLessThan(12);
  const scene = (await page.locator(".overview-scene").boundingBox())!;
  expect(scene.y).toBeLessThan(250);
  await assertShellScrolling(page, "390 overview");
  const footer = (await page.locator(".bottombar").boundingBox())!;
  // Readable controls may grow the footer; require containment, not a compact-height cap.
  expect(footer.y).toBeGreaterThanOrEqual(0);
  expect(footer.y + footer.height).toBeCloseTo(844, 1);
  await expect(page.locator(".footer-details")).toBeHidden();
  expect(
    await page
      .locator(".timeline-scroll")
      .evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBe(0);
  expect(await page.locator(".mobile-hour-label").allTextContents()).toEqual([
    "0",
    "6",
    "12",
    "18",
  ]);
  const slider = page.getByRole("slider", { name: "24 小时时间轴" });
  const touch = (await slider.boundingBox())!;
  expect(touch.width).toBeGreaterThan(300);
  expect(touch.height).toBeGreaterThanOrEqual(36);
  await setTimelineHour(page, 10);
  await expect(page.locator(".clock")).toContainText("10:00:00");
  await expect(page.getByLabel("当前本地日期")).toHaveText(
    "2026-10-01 周四 国庆节",
  );
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
  const verdict = await page.locator(".agent-verdict").evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    body: el.querySelector(".verdict-body")!.getBoundingClientRect().height,
    last: el.querySelector(".dispatch-note")!.getBoundingClientRect().bottom,
    bottom: el.getBoundingClientRect().bottom,
  }));
  await assertShellScrolling(page, "390 selected hour");
  console.log("MOBILE_VERDICT", JSON.stringify(verdict));
  expect.soft(verdict.bottom - verdict.last).toBeLessThan(25);
  await expect(page.locator(".agent-verdict")).not.toContainText("RULE");
  const tiny = await page
    .locator(".topbar,.bottombar,.overview-grid")
    .evaluateAll((roots) =>
      roots.flatMap((root) =>
        [...root.querySelectorAll<HTMLElement>("*")]
          .filter(
            (el) =>
              el.checkVisibility({ checkVisibilityCSS: true }) &&
              el.textContent?.trim() &&
              !el.matches(".type-number > .type-unit") &&
              parseFloat(getComputedStyle(el).fontSize) < 12,
          )
          .map((el) => ({
            c: el.className,
            tag: el.tagName,
            parent: el.parentElement?.className,
            size: getComputedStyle(el).fontSize,
          })),
      ),
    );
  expect(tiny).toEqual([]);
  // --font-unit is now a CSS max() length (12px floor), not a numeric ratio.
  const units = await page
    .locator(".overview-number > .type-unit")
    .evaluateAll((es) =>
      es.map((el) => {
        const parent = el.parentElement!,
          probe = document.createElement("span");
        probe.style.fontSize = "var(--font-unit)";
        parent.append(probe);
        const expected = parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return { actual: parseFloat(getComputedStyle(el).fontSize), expected };
      }),
    );
  for (const unit of units) {
    expect(unit.actual).toBeGreaterThanOrEqual(12);
    expect(unit.actual).toBeGreaterThanOrEqual(unit.expected - 0.01);
  }
  const buttons = await page
    .locator(".topbar button,.bottombar > button,.overview-scene button")
    .evaluateAll((es) =>
      es
        .filter((el) => el.checkVisibility())
        .map((el) => el.getBoundingClientRect().height),
    );
  expect(buttons.every((height) => height >= 36)).toBe(true);
  await setTimelineHour(page, 23);
  await expect(
    page.getByRole("button", { name: "回到当前", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "回到当前", exact: true }).click();
  await expect(page.locator(".clock")).toContainText("14:00:00");
  await expect(
    page.getByRole("button", { name: "▶ 播放", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(page.locator(".about-page")).toContainText("BDG2");
  await expect(page.locator(".about-page")).toContainText("CC BY-SA 4.0");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
