import { test, expect } from "@playwright/test";
import { inspectShellScrolling } from "./shell-scroll-policy";

test("1–7px auto overflow is rejected on either axis, including a table; 8px main scroll is necessary", async ({
  page,
}) => {
  for (let excess = 1; excess < 8; excess++) {
    await page.setContent(
      `<style>body{margin:0}main{width:300px;height:100px;overflow:auto}.content{height:${100 + excess}px;width:300px}</style><main><div class="content"></div></main>`,
    );
    expect(
      (await page.evaluate(inspectShellScrolling)).map((x) => x.reason),
      `vertical ${excess}px`,
    ).toContain("vertical scrollbar for less than 8px overflow");
    await page.setContent(
      `<style>body{margin:0}main{width:300px}.table-scroll{width:300px;overflow-x:auto}table{border-collapse:collapse;width:${300 + excess}px}</style><main><div class="table-scroll"><table><tr><td>Table</td></tr></table></div></main>`,
    );
    expect(
      (await page.evaluate(inspectShellScrolling)).map((x) => x.reason),
      `table horizontal ${excess}px`,
    ).toContain("horizontal scrollbar for less than 8px overflow");
  }
  await page.setContent(
    '<style>body{margin:0}main{width:300px;height:100px;overflow:auto}.content{height:108px}</style><main><div class="content"></div></main>',
  );
  expect(await page.evaluate(inspectShellScrolling)).toEqual([]);
});
test("scroll policy accepts necessary main/list scroll and rejects empty bars, clipping and horizontal overflow", async ({
  page,
}) => {
  await page.setContent(
    '<style>body{margin:0}main{width:300px;height:100px;overflow:auto}.content{height:250px;width:100%}</style><main><div class="content">Long content</div></main>',
  );
  expect(await page.evaluate(inspectShellScrolling)).toEqual([]);
  await page
    .locator(".content")
    .evaluate((el) => ((el as HTMLElement).style.height = "50px"));
  expect(await page.evaluate(inspectShellScrolling)).toEqual([]);
  await page
    .locator("main")
    .evaluate((el) => ((el as HTMLElement).style.overflowY = "scroll"));
  expect(
    (await page.evaluate(inspectShellScrolling)).map((x) => x.reason),
  ).toContain("scrollbar although content fits");
  await page
    .locator("main")
    .evaluate((el) => ((el as HTMLElement).style.overflowY = "hidden"));
  await page
    .locator(".content")
    .evaluate((el) => ((el as HTMLElement).style.height = "250px"));
  expect(
    (await page.evaluate(inspectShellScrolling)).map((x) => x.reason),
  ).toContain("main content clipped instead of scrollable");
  await page
    .locator("main")
    .evaluate((el) => ((el as HTMLElement).style.overflow = "auto"));
  await page
    .locator(".content")
    .evaluate((el) => ((el as HTMLElement).style.width = "400px"));
  expect(
    (await page.evaluate(inspectShellScrolling)).map((x) => x.reason),
  ).toContain("horizontal overflow");
  await page.setContent(
    '<main style="width:300px"><ul style="height:50px;overflow:auto"><li style="height:200px">Long list</li></ul></main>',
  );
  expect(await page.evaluate(inspectShellScrolling)).toEqual([]);
  await page.setContent(
    '<main style="width:300px;overflow:auto"><div class="table-scroll" style="width:300px;overflow-x:auto"><table style="width:500px"><tr><td>Wide table</td></tr></table></div></main>',
  );
  expect(await page.evaluate(inspectShellScrolling)).toEqual([]);
  await page
    .locator(".table-scroll")
    .evaluate((el) => ((el as HTMLElement).style.width = "500px"));
  expect(
    (await page.evaluate(inspectShellScrolling)).some(
      (x) => x.class.includes("main") || x.axis === "x",
    ),
  ).toBe(true);
});
