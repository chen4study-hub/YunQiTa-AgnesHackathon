import { test, expect } from "@playwright/test";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));

for (const target of ["AboutPage", "OverviewPage"])
  test(`${target} render failure is isolated, navigation works and retry restores content`, async ({
    page,
  }) => {
    // Inject into the served page module, not production source or the boundary itself.
    // Keep throwing through React's automatic retries until explicitly cleared.
    await page.addInitScript(() => {
      (window as any).__pageFault = true;
    });
    await page.route(`**/src/pages/${target}.tsx*`, async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const signature = `function ${target}() {`;
      expect(body).toContain(signature);
      await route.fulfill({
        response,
        body: body.replace(
          signature,
          `${signature}\n if (window.__pageFault) throw new Error('injected page render failure');`,
        ),
      });
    });
    await page.goto("/?source=file");
    const nav = page.getByRole("navigation", { name: "页面导航" });
    if (target === "AboutPage")
      await nav.getByRole("button", { name: /关于/ }).click();
    const failure = page
      .locator("main")
      .getByRole("alert", { name: "页面加载失败" });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText("该页面加载失败");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("button")).toHaveCount(6);
    await expect(page.locator(".bottombar")).toBeVisible();
    await expect(page.locator(".timeline")).toBeVisible();
    const healthyLabel = target === "AboutPage" ? /总览/ : /关于/;
    await nav.getByRole("button", { name: healthyLabel }).click();
    await expect(
      page.locator(target === "AboutPage" ? ".twin-scene" : ".about-page"),
    ).toBeVisible();
    await expect(failure).not.toBeVisible();
    await nav.getByRole("button", { name: /预测与风险/ }).click();
    await expect(page.locator("main")).toHaveAttribute("data-page", "forecast");
    await expect(page.locator(".forecast-page")).toBeVisible();
    await nav
      .getByRole("button", { name: target === "AboutPage" ? /关于/ : /总览/ })
      .click();
    await expect(failure).toBeVisible();
    // A still-broken page must fail locally again, not tear down the shell.
    await failure.getByRole("button", { name: "重试", exact: true }).click();
    await expect(failure).toBeVisible();
    await expect(nav).toBeVisible();
    await page.evaluate(() => {
      (window as any).__pageFault = false;
    });
    await failure.getByRole("button", { name: "重试", exact: true }).click();
    await expect(failure).not.toBeVisible();
    await expect(
      page.locator(target === "AboutPage" ? ".about-page" : ".twin-scene"),
    ).toBeVisible();
    await expect(nav).toBeVisible();
    await expect(page.locator(".bottombar")).toBeVisible();
  });

test("alternate production Vite config without injected metadata renders About and navigation", async ({
  page,
}) => {
  test.setTimeout(90000);
  const output = await mkdtemp(path.join(tmpdir(), "yunqi-no-defines-"));
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await build({
      root,
      configFile: false,
      plugins: [react()],
      build: { outDir: output, emptyOutDir: true },
      logLevel: "error",
    });
    server = await preview({
      root,
      configFile: false,
      build: { outDir: output },
      preview: { host: "127.0.0.1", port: 0 },
    });
    await page.goto(
      `http://127.0.0.1:${(server.httpServer.address() as { port: number }).port}/?source=file`,
    );
    const nav = page.getByRole("navigation", { name: "页面导航" });
    await nav.getByRole("button", { name: /关于/ }).click();
    await expect(page.locator(".about-page")).toBeVisible();
    await expect(page.locator(".about-revision")).toHaveText("源码包");
    await expect(page.locator(".about-build-time")).toHaveText("源码包");
    await nav.getByRole("button", { name: /总览/ }).click();
    await expect(page.locator(".twin-scene")).toBeVisible();
    await expect(page.locator(".bottombar")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (server)
      await new Promise<void>((resolve) =>
        server!.httpServer.close(() => resolve()),
      );
    await rm(output, { recursive: true, force: true });
  }
});
