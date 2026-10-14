import { expect, test } from "@playwright/test";
for (const scenario of ["normal", "peak", "abstain"]) {
  test(`${scenario}: floor and energy visible wording follows the live calendar`, async ({
    page,
  }) => {
    await page.goto(`/?source=file&scenario=${scenario}&at=2026-10-12T14:00`);
    for (const name of ["楼层与电梯", "能源与告警"]) {
      await page.getByRole("button", { name, exact: false }).click();
      await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
      const text = await page
        .locator(name === "楼层与电梯" ? ".floors-page" : ".energy-page")
        .innerText();
      expect(text).not.toMatch(/典型日|情景|代表日|高温日|节假日/);
      const root = page.locator(
        name === "楼层与电梯" ? ".floors-page" : ".energy-page",
      );
      await expect(root).toHaveAttribute("data-date", "2026-10-12 周一");
      if (name === "能源与告警") {
        await expect(root.locator(".energy-heading time:not(.energy-cursor-time)")).toHaveText(
          "2026-10-12 周一 · 14:00",
        );
        await expect(root.locator(".energy-cursor-time")).toHaveText("当前 14:00");
        await expect(root.locator(".energy-heading time:not(.energy-cursor-time)")).toHaveAttribute("datetime", "2026-10-12T14:00:00");
        expect(
          await root
            .locator("tbody time")
            .evaluateAll((es) =>
              es.every((e) =>
                e.getAttribute("datetime")?.startsWith("2026-10-12T"),
              ),
            ),
        ).toBe(true);
        for (const id of await root
          .locator(".energy-order-id")
          .allTextContents())
          expect(id).toContain("2026-10-12");
      }
    }
  });
}
