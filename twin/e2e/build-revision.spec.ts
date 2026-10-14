import { test, expect } from "@playwright/test";
import { preview, createServer, type PreviewServer } from "vite";
import { mkdtemp, cp, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
test("dev About revision has a value", async ({ page }) => {
  await page.goto("/?source=file");
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(page.locator(".about-revision")).toHaveText(
    /^[a-f0-9]{7,40}$|^源码包$/,
  );
});
test("source archive outside repository builds and serves without .git or Git executable", async ({
  page,
}) => {
  test.setTimeout(90000);
  const temp = await mkdtemp(path.join(tmpdir(), "yunqi-source-archive-"));
  let dev: Awaited<ReturnType<typeof createServer>> | undefined;
  let archivePreview: PreviewServer | undefined;
  try {
    for (const name of [
      "src",
      "scripts",
      "public",
      "package.json",
      "package-lock.json",
      "index.html",
      "showcase.html",
      "tsconfig.json",
      "vite.config.ts",
    ])
      await cp(path.join(root, name), path.join(temp, name), {
        recursive: true,
      });
    // Dependencies are reused, but all authored source/config/output live outside the repository.
    await symlink(
      path.join(root, "node_modules"),
      path.join(temp, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const env = {
      ...process.env,
      PATH: path.dirname(process.execPath),
      GIT_CEILING_DIRECTORIES: temp,
      VITE_GIT_COMMIT: "",
    };
    execFileSync(
      process.execPath,
      ["node_modules/typescript/bin/tsc", "--noEmit"],
      { cwd: temp, env, timeout: 30000 },
    );
    execFileSync(process.execPath, ["scripts/licenses.mjs", "--emit"], {
      cwd: temp,
      env,
      timeout: 30000,
    });
    execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      cwd: temp,
      env,
      timeout: 30000,
      stdio: "pipe",
    });
    expect(
      JSON.parse(
        await readFile(path.join(temp, "dist/build-info.json"), "utf8"),
      ).revision,
    ).toBeNull();
    dev = await createServer({
      root: temp,
      configFile: path.join(temp, "vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [temp, path.join(root, "node_modules")] },
      },
    });
    await dev.listen();
    await page.goto(
      `http://127.0.0.1:${(dev.httpServer!.address() as { port: number }).port}/?source=file`,
    );
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-revision")).toHaveText("源码包");
    archivePreview = await preview({
      root: temp,
      configFile: path.join(temp, "vite.config.ts"),
      preview: { host: "127.0.0.1", port: 0 },
    });
    await page.goto(
      `http://127.0.0.1:${(archivePreview.httpServer.address() as { port: number }).port}/?source=file`,
    );
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-revision")).toHaveText("源码包");
    await new Promise<void>((r) => archivePreview!.httpServer.close(() => r()));
    archivePreview = undefined;
    execFileSync(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "build", "--outDir", "dist-env"],
      {
        cwd: temp,
        env: {
          ...env,
          VITE_GIT_COMMIT: "abcdef0123456789abcdef0123456789abcdef01",
        },
        timeout: 30000,
        stdio: "pipe",
      },
    );
    expect(
      JSON.parse(
        await readFile(path.join(temp, "dist-env/build-info.json"), "utf8"),
      ).revision,
    ).toBe("abcdef0");
    archivePreview = await preview({
      root: temp,
      configFile: path.join(temp, "vite.config.ts"),
      build: { outDir: "dist-env" },
      preview: { host: "127.0.0.1", port: 0 },
    });
    await page.goto(
      `http://127.0.0.1:${(archivePreview.httpServer.address() as { port: number }).port}/?source=file`,
    );
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-revision")).toHaveText("abcdef0");
  } finally {
    await dev?.close();
    if (archivePreview)
      await new Promise<void>((r) =>
        archivePreview!.httpServer.close(() => r()),
      );
    await rm(temp, { recursive: true, force: true });
  }
});
// Build isolated production output; never read or overwrite the stable twin/dist.
test("production About revision equals build provenance and Git short hash", async ({
  page,
}) => {
  test.setTimeout(180000);
  const temp = await mkdtemp(path.join(tmpdir(), "yunqi-build-revision-"));
  let server: PreviewServer | undefined;
  try {
    // Capture before building: another session may commit while the test runs.
    let expected: string | null = null;
    try {
      expected = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
    await exec(
      process.execPath,
      ["node_modules/vite/bin/vite.js", "build", "--outDir", temp],
      { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
    );
    server = await preview({
      root,
      build: { outDir: temp },
      preview: { host: "127.0.0.1", port: 0 },
    });
    const port = (server.httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const response = await page.request.get(`${base}/build-info.json`);
    expect(response.ok()).toBe(true);
    const info = await response.json();
    expect(info.revision).toBe(expected);
    await page.goto(`${base}/?source=file`);
    await page.getByRole("button", { name: "关于", exact: false }).click();
    await expect(page.locator(".about-revision")).toHaveText(
      expected ?? "源码包",
    );
    await expect(page.locator(".about-build")).not.toContainText("未提供");
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.httpServer.close((error) =>
          error ? reject(error) : resolve(),
        ),
      );
    await rm(temp, { recursive: true, force: true });
  }
});
