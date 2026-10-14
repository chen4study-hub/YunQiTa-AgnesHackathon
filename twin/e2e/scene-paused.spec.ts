import { test, expect } from "@playwright/test";
import { freezeTestHmr } from "./shell-scroll-policy";
test.beforeEach(async ({ page }) => {
  await freezeTestHmr(page);
  // Isolate scene activity from mutable takeover/schedule state on the shared backend.
  await page.route("**/api/**", r => r.abort());
});
test("mobile projected labels keep complete metrics inside canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?source=file");
  await expect(page.locator(".twin-scene")).toHaveAttribute(
    "data-render-active",
    "true",
  );
  await expect
    .poll(() =>
      page.locator(".scene-labels").evaluate((root) => {
        const box = root.getBoundingClientRect();
        return [...root.querySelectorAll<HTMLElement>("[data-anchor]")]
          .filter((el) => getComputedStyle(el).visibility === "visible")
          .every((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= box.left && r.right <= box.right;
          });
      }),
    )
    .toBe(true);
});
test("hidden overview stops render and projection RAF requests, resumes the same canvas", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    const counts = { render: 0, projection: 0 };
    (window as any).__sceneRequests = counts;
    window.requestAnimationFrame = (callback) => {
      const code = Function.prototype.toString.call(callback);
      if (/composer\.render\(/.test(code)) counts.render++;
      if (/scene\.project\(/.test(code)) counts.projection++;
      return original(callback);
    };
  });
  await page.goto("/?source=file&at=2026-10-12T14:00");
  await expect(page.locator(".twin-scene")).toHaveAttribute(
    "data-render-active",
    "true",
  );
  const counts = () =>
    page.evaluate(
      () =>
        (window as any).__sceneRequests as {
          render: number;
          projection: number;
        },
    );
  await expect.poll(async () => (await counts()).render).toBeGreaterThan(2);
  await expect.poll(async () => (await counts()).projection).toBeGreaterThan(2);
  const canvas = await page.locator(".twin-scene canvas").elementHandle();
  for (const [name, id] of [
    ["关于", "about"],
    ["预测与风险", "forecast"],
    ["楼层与电梯", "floors"],
  ]) {
    await page.getByRole("button", { name, exact: false }).click();
    await expect(page.locator("main")).toHaveAttribute("data-page", id);
    await expect(page.locator(".twin-scene")).toHaveAttribute(
      "data-render-active",
      "false",
    );
    await page.waitForTimeout(100);
    const before = await counts();
    const state = await page.locator(".twin-scene").getAttribute("data-scene");
    await page.waitForTimeout(350);
    expect(await counts()).toEqual(before);
    expect(await page.locator(".twin-scene").getAttribute("data-scene")).toBe(
      state,
    );
    await page.getByRole("button", { name: "总览", exact: false }).click();
    await expect(page.locator("main")).toHaveAttribute("data-page", "overview");
    await expect(page.locator(".twin-scene")).toHaveAttribute(
      "data-render-active",
      "true",
    );
    await expect
      .poll(async () => (await counts()).render)
      .toBeGreaterThan(before.render + 2);
    await expect
      .poll(async () => (await counts()).projection)
      .toBeGreaterThan(before.projection + 2);
    expect(
      await canvas!.evaluate(
        (el) => el === document.querySelector(".twin-scene canvas"),
      ),
    ).toBe(true);
  }
});
