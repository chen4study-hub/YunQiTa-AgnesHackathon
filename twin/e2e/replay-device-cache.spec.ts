import { test, expect, type Page } from "@playwright/test";
import {
  build,
  createServer,
  preview,
  type ViteDevServer,
  type PreviewServer,
} from "vite";
import { compression, defineAlgorithm } from "vite-plugin-compression2";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { createHash } from "node:crypto";
import { dataManifest } from "../scripts/dataManifest";
import { previewCompression } from "../scripts/previewCompression";

const root = fileURLToPath(new URL("../", import.meta.url));
let directory: string,
  dev: ViteDevServer,
  app: ViteDevServer,
  prod: PreviewServer,
  devUrl: string,
  prodUrl: string;
const body = (value: number) => JSON.stringify({ value });
const hash = (value: number) =>
  createHash("sha256").update(body(value)).digest("hex");
const plugins = (): import("vite").Plugin[] => [
  dataManifest(),
  previewCompression(),
  {
    name: "test-binary-asset",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "assets/font-a1b2c3d4.woff2",
        source: new Uint8Array([1, 2, 3]),
      });
    },
  },
  compression({
    include: /\.(js|css|json|html)$/i,
    threshold: 0,
    skipIfLargerOrEqual: false,
    algorithms: [defineAlgorithm("gzip", { level: 9 }), "brotliCompress"],
  }),
];
async function compile() {
  await build({
    root: directory,
    configFile: false,
    logLevel: "silent",
    plugins: plugins(),
    build: { outDir: "dist" },
  });
}
function origin(server: ViteDevServer | PreviewServer) {
  return `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
}
function raw(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: Buffer;
  }>((resolve, reject) => {
    const req = request(url, { headers, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}
async function loaded(page: Page, url: string, value: number) {
  await page.goto(url);
  await expect(page.locator("output")).toHaveText(String(value));
}
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.setTimeout(120000);
  await mkdir(path.join(root, ".tools"), { recursive: true });
  directory = await mkdtemp(path.join(root, ".tools/data-cache-"));
  await mkdir(path.join(directory, "public/replay"), { recursive: true });
  await writeFile(path.join(directory, "public/replay/test.json"), body(1));
  await writeFile(
    path.join(directory, "cache.ts"),
    await readFile(path.join(root, "src/data/deviceDataCache.ts")),
  );
  await writeFile(
    path.join(directory, "index.html"),
    '<!doctype html><html><body><output>loading</output><script type="module" src="/main.ts"></script></body></html>',
  );
  await writeFile(
    path.join(directory, "main.ts"),
    `import {installDeviceDataCache} from './cache';
installDeviceDataCache();
async function load() { const data = await (await fetch('/replay/test.json')).json(); document.querySelector('output').textContent = String(data.value); }
load().catch(e => document.querySelector('output').textContent = e.message);`,
  );
  await compile();
  prod = await preview({
    root: directory,
    configFile: false,
    plugins: plugins(),
    preview: { host: "127.0.0.1", port: 0 },
  });
  dev = await createServer({
    root: directory,
    configFile: false,
    plugins: [dataManifest()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await dev.listen();
  prodUrl = origin(prod);
  devUrl = origin(dev);
});
test.afterAll(async () => {
  if (dev) await dev.close();
  if (app) await app.close();
  if (prod)
    await new Promise<void>((resolve, reject) =>
      prod.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("second refresh and another tab reuse parsed device data, but still validate manifest", async ({
  page,
  context,
}) => {
  const dataRequests: string[] = [],
    manifestRequests: string[] = [];
  context.on("request", (req) => {
    if (new URL(req.url()).pathname === "/replay/test.json")
      dataRequests.push(req.url());
    if (new URL(req.url()).pathname === "/data-manifest.json")
      manifestRequests.push(req.url());
  });
  await loaded(page, prodUrl, 1);
  expect(dataRequests).toEqual([
    `${prodUrl}/replay/test.json?v=${hash(1).slice(0, 12)}`,
  ]);
  await loaded(page, prodUrl, 1);
  const other = await context.newPage();
  await loaded(other, prodUrl, 1);
  await other.close();
  expect(dataRequests).toHaveLength(1);
  expect(manifestRequests).toHaveLength(3);
});
test("two tabs starting together share one download through the origin lock", async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  context.on("request", (req) => {
    if (new URL(req.url()).pathname === "/replay/test.json")
      requests.push(req.url());
  });
  const other = await context.newPage();
  await Promise.all([loaded(page, prodUrl, 1), loaded(other, prodUrl, 1)]);
  expect(requests).toHaveLength(1);
  await other.close();
});
test("dev recalculates versions; changing one file downloads new content and replaces old record", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/replay/test.json")
      requests.push(req.url());
  });
  await loaded(page, devUrl, 1);
  await writeFile(path.join(directory, "public/replay/test.json"), body(2));
  await loaded(page, devUrl, 2);
  await loaded(page, devUrl, 2);
  expect(requests).toEqual([
    `${devUrl}/replay/test.json?v=${hash(1).slice(0, 12)}`,
    `${devUrl}/replay/test.json?v=${hash(2).slice(0, 12)}`,
  ]);
  const cached = await page.evaluate(
    () =>
      new Promise<{ count: number; sha256: string }>((resolve, reject) => {
        const open = indexedDB.open("yunqi-data-cache", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("files"),
            request = tx.objectStore("files").getAll();
          tx.oncomplete = () => {
            resolve({
              count: request.result.length,
              sha256: request.result[0].sha256,
            });
            db.close();
          };
        };
      }),
  );
  expect(cached).toEqual({ count: 1, sha256: hash(2) });
  const response = await raw(devUrl + "/data-manifest.json");
  expect(JSON.parse(response.body.toString()).files["test.json"].sha256).toBe(
    hash(2),
  );
  expect(
    (
      await raw(devUrl + "/data-manifest.json", {
        "If-None-Match": String(response.headers.etag),
      })
    ).status,
  ).toBe(304);
});
test("preview HTML/manifest/data revalidate with ETags; hashed assets are immutable for a year", async () => {
  const html = await raw(prodUrl + "/");
  const asset = html.body.toString().match(/\/assets\/[\w-]+\.js/)![0];
  expect((await raw(prodUrl + asset)).headers["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(
    (await raw(prodUrl + "/assets/font-a1b2c3d4.woff2")).headers[
      "cache-control"
    ],
  ).toBe("public, max-age=31536000, immutable");
  for (const name of [
    "/",
    "/index.html",
    "/data-manifest.json",
    `/replay/test.json?v=${hash(1).slice(0, 12)}`,
  ]) {
    for (const encoding of ["identity", "gzip", "br"]) {
      const initial = await raw(prodUrl + name, {
        "Accept-Encoding": encoding,
      });
      expect(initial.status).toBe(200);
      expect(initial.headers["cache-control"]).toBe("no-cache");
      expect(initial.headers.etag).toBeTruthy();
      const cached = await raw(prodUrl + name, {
        "Accept-Encoding": encoding,
        "If-None-Match": String(initial.headers.etag),
      });
      expect(cached.status).toBe(304);
      expect(cached.body.length).toBe(0);
      expect(
        (await raw(prodUrl + name, { "Accept-Encoding": encoding }, "HEAD"))
          .body.length,
      ).toBe(0);
    }
  }
  const manifest = JSON.parse(
    (await raw(prodUrl + "/data-manifest.json")).body.toString(),
  );
  expect(manifest.files["test.json"].sha256).toBe(hash(1));
});
test("application entry installs the cache without editing existing data adapters", async ({
  page,
}) => {
  test.setTimeout(90000);
  app = await createServer({
    root,
    cacheDir: path.join(directory, "app-vite"),
    server: { host: "127.0.0.1", port: 0 },
  });
  await app.listen();
  await page.route("**/api/**", (route) => route.abort());
  const requests: string[] = [],
    manifestRequests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/replay/model_card.json")
      requests.push(req.url());
    if (new URL(req.url()).pathname === "/data-manifest.json")
      manifestRequests.push(req.url());
  });
  await page.goto(`${origin(app)}/?source=file&at=2026-10-12T14:00`);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
    timeout: 30000,
  });
  await page.evaluate(async () =>
    (await fetch("/replay/model_card.json")).json(),
  );
  await expect(page.locator(".scene-legend")).toContainText("低 21.1 kW", {
    timeout: 30000,
  });
  expect(manifestRequests).toHaveLength(1);
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false", {
    timeout: 30000,
  });
  await page.evaluate(async () =>
    (await fetch("/replay/model_card.json")).json(),
  );
  await expect(page.locator(".scene-legend")).toContainText("低 21.1 kW", {
    timeout: 30000,
  });
  expect(manifestRequests).toHaveLength(2);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatch(/\?v=[a-f0-9]{12}$/);
});
test("unavailable IndexedDB falls back to versioned network on refresh", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, "indexedDB", {
      get() {
        throw new Error("disabled");
      },
    }),
  );
  const requests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/replay/test.json")
      requests.push(req.url());
  });
  await loaded(page, prodUrl, 1);
  await loaded(page, prodUrl, 1);
  expect(requests).toHaveLength(2);
  expect(requests.every((url) => url.includes("?v="))).toBe(true);
});
test("a rebuilt deployment refreshes the existing device record only for the new version", async ({
  page,
}) => {
  test.setTimeout(60000);
  const requests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/replay/test.json")
      requests.push(req.url());
  });
  await loaded(page, prodUrl, 1);
  await writeFile(path.join(directory, "public/replay/test.json"), body(2));
  await compile();
  await loaded(page, prodUrl, 2);
  await loaded(page, prodUrl, 2);
  expect(requests).toEqual([
    `${prodUrl}/replay/test.json?v=${hash(1).slice(0, 12)}`,
    `${prodUrl}/replay/test.json?v=${hash(2).slice(0, 12)}`,
  ]);
});
