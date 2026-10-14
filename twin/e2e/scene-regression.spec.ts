import { test, expect, type Page } from "@playwright/test";
async function snapshot(page: Page) {
  return page
    .locator(".twin-scene")
    .evaluate((e) => JSON.parse((e as HTMLElement).dataset.scene!));
}
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
test.beforeEach(async ({ page }) => {
  await page.goto("/?source=mock");
  await expect
    .poll(async () =>
      Boolean(await page.locator(".twin-scene").getAttribute("data-scene")),
    )
    .toBe(true);
});
test("timeline sliding highlight and fine progress follow the shared time", async ({
  page,
}) => {
  await button(page, "▶ 播放").click();
  const ok = await page.locator(".timeline").evaluate(async (e) => {
    let last = Number(e.getAttribute("data-time"));
    let left = -1;
    for (let i = 0; i < 40; i++) {
      await new Promise(requestAnimationFrame);
      const t = Number(e.getAttribute("data-time"));
      const selected = e.querySelector(".current");
      const slider = e.querySelector(".timeline-slider")!;
      const x = slider.getBoundingClientRect().x;
      if (
        Number(selected?.getAttribute("data-hour")) !== Math.floor(t) ||
        t < last ||
        x < left
      )
        return false;
      last = t;
      left = x;
    }
    return true;
  });
  expect(ok).toBe(true);
  await expect(page.locator(".timeline-cursor")).toHaveCount(1);
});
test("reset button smoothly returns camera then restores auto rotation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await button(page, "展开楼层").click();
  await page.waitForTimeout(800);
  const before = await snapshot(page);
  await button(page, "重置视角").click();
  expect((await snapshot(page)).camera[0]).toBeCloseTo(before.camera[0], -1);
  await expect
    .poll(async () => (await snapshot(page)).transitioning, { timeout: 8000 })
    .toBe(false);
  await expect.poll(async () => (await snapshot(page)).rotating).toBe(true);
});
test("manual drag pauses rotation and restores it after release", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForTimeout(2000);
  const box = (await page.locator(".twin-scene canvas").boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 150);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 170, { steps: 8 });
  expect((await snapshot(page)).rotating).toBe(false);
  await page.mouse.up();
  await expect
    .poll(async () => (await snapshot(page)).rotating, { timeout: 6000 })
    .toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await snapshot(page)).rotating).toBe(false);
});
test("floor expansion and collapse animate intermediate spacing", async ({
  page,
}) => {
  // Dataset exists before shader preparation completes. Observe a ready render first.
  await expect(page.locator(".twin-scene")).toHaveAttribute("data-scene-ready", "true", { timeout: 30000 });
  await button(page, "展开楼层").click();
  await page.waitForTimeout(160);
  const mid = await snapshot(page);
  expect(mid.spacing).toBeGreaterThan(1.3);
  expect(mid.spacing).toBeLessThan(2.4);
  await expect
    .poll(async () => (await snapshot(page)).spacing)
    .toBeGreaterThan(2.39);
  await button(page, "展开楼层").click();
  await page.waitForTimeout(160);
  const back = await snapshot(page);
  expect(back.spacing).toBeGreaterThan(1.3);
  expect(back.spacing).toBeLessThan(2.4);
});
test("camera transition and tab return preserve the canvas", async ({
  page,
}) => {
  await expect(page.locator(".twin-scene")).toHaveAttribute("data-scene-ready", "true", { timeout: 30000 });
  const before = await snapshot(page);
  await button(page, "展开楼层").click();
  await page.waitForTimeout(200);
  const mid = await snapshot(page);
  expect(mid.camera).not.toEqual(before.camera);
  expect(mid.transitioning).toBe(true);
  await page
    .locator(".twin-scene canvas")
    .evaluate((e) => e.setAttribute("data-persist", "yes"));
  await page.getByRole("button", { name: "关于 ABOUT" }).click();
  await page.getByRole("button", { name: "总览 OVERVIEW" }).click();
  await expect(page.locator(".twin-scene canvas")).toHaveAttribute(
    "data-persist",
    "yes",
  );
});
test("xray changes glass transparency and is reversible", async ({ page }) => {
  await button(page, "透视").click();
  await expect
    .poll(async () => (await snapshot(page)).glassOpacity)
    .toBeCloseTo(0.12);
  await button(page, "透视").click();
  await expect.poll(async () => (await snapshot(page)).glassOpacity).toBe(1);
});
test("heat and real appearances switch material colors", async ({ page }) => {
  await page.waitForTimeout(600);
  const heat = (await snapshot(page)).color;
  await button(page, "真实外观").click();
  await page.waitForTimeout(900);
  expect((await snapshot(page)).mode).toBe("real");
  expect((await snapshot(page)).color).not.toBe(heat);
  await button(page, "能耗着色").click();
  await expect.poll(async () => (await snapshot(page)).mode).toBe("heat");
});
test("floor ray picking selects a floor and smoothly focuses camera", async ({
  page,
}) => {
  await page.waitForTimeout(1800);
  const s = await snapshot(page);
  const box = (await page.locator(".twin-scene canvas").boundingBox())!;
  await page.mouse.click(box.x + s.floorPoint.x, box.y + s.floorPoint.y);
  await expect.poll(async () => (await snapshot(page)).selected).not.toBeNull();
  await expect(
    page.getByRole("button", { name: /F · 取消选择/ }),
  ).toBeVisible();
  expect((await snapshot(page)).transitioning).toBe(true);
});
test("crown base and fins inherit floor 40 twist angle", async ({ page }) => {
  const s = await snapshot(page);
  expect(s.crownAngle).toBeCloseTo(s.floorAngle, 10);
  s.crownParts.forEach((angle: number) =>
    expect(angle).toBeCloseTo(s.floorAngle, 10),
  );
  expect(s.spireCenter[0]).toBe(0);
  expect(s.spireCenter[2]).toBe(0);
});
