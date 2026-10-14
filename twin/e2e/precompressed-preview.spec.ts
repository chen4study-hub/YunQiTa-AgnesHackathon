import { test, expect } from "@playwright/test";
import { preview, type PreviewServer } from "vite";
import { readdir, readFile } from "node:fs/promises";
import { request } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
let server: PreviewServer, base: string;
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? files(path.join(dir, e.name))
          : [path.join(dir, e.name)],
      ),
    )
  ).flat();
}
// Node HTTP preserves the compressed bytes, unlike browser/APIResponse auto decoding.
function raw(
  url: string,
  encoding: string,
  method = "GET",
  extra: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: Buffer;
  }>((resolve, reject) => {
    const req = request(
      url,
      { method, headers: { "Accept-Encoding": encoding, ...extra } },
      (res) => {
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
      },
    );
    req.on("error", reject);
    req.end();
  });
}
test.beforeAll(async () => {
  server = await preview({ root, preview: { host: "127.0.0.1", port: 0 } });
  base = `http://127.0.0.1:${(server.httpServer.address() as { port: number }).port}`;
});
test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
});

test("every built JS, CSS and JSON has lossless Brotli and gzip sidecars, including public data", async () => {
  const assets = (await files(dist)).filter((f) => /\.(js|css|json)$/i.test(f));
  expect(assets.length).toBeGreaterThan(10);
  expect(assets).toContain(path.join(dist, "replay/normal.json"));
  for (const file of assets) {
    const original = await readFile(file);
    expect(
      brotliDecompressSync(await readFile(file + ".br")).equals(original),
      file + ".br",
    ).toBe(true);
    expect(
      gunzipSync(await readFile(file + ".gz")).equals(original),
      file + ".gz",
    ).toBe(true);
  }
  const sizes = await Promise.all(
    assets
      .filter(
        (f) =>
          f.endsWith(".js") ||
          f.endsWith(".css") ||
          f === path.join(dist, "replay/normal.json"),
      )
      .map(async (f) => ({
        file: path.relative(dist, f),
        raw: (await readFile(f)).length,
        gzip: (await readFile(f + ".gz")).length,
        br: (await readFile(f + ".br")).length,
      })),
  );
  console.log("PRECOMPRESSED_BYTES", JSON.stringify(sizes));
});
test("preview negotiates Brotli, gzip, identity and quality; types and Vary reflect original assets", async () => {
  const assets = (await files(dist)).filter((f) => /\.(js|css)$/i.test(f));
  for (const file of [
    ...assets,
    path.join(dist, "replay/normal.json"),
    path.join(dist, "build-info.json"),
  ]) {
    const url =
      base + "/" + path.relative(dist, file).split(path.sep).join("/") + "?v=1";
    const response = await raw(url, "gzip, br");
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers.vary?.toLowerCase()).toContain("accept-encoding");
    expect(response.headers["content-type"]).toMatch(
      file.endsWith(".json")
        ? /^application\/json/
        : file.endsWith(".css")
          ? /^text\/css/
          : /^(text|application)\/javascript/,
    );
    expect(response.body.equals(await readFile(file + ".br"))).toBe(true);
    expect(Number(response.headers["content-length"])).toBe(
      response.body.length,
    );
  }
  const file = path.join(dist, "replay/normal.json"),
    url = base + "/replay/normal.json";
  for (const encoding of ["gzip", "br;q=0, gzip;q=1", "gzip;q=1, br;q=0.5"]) {
    const response = await raw(url, encoding);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.body).equals(await readFile(file))).toBe(true);
  }
  const identity = await raw(url, "br;q=0,gzip;q=0");
  expect(identity.headers["content-encoding"]).toBeUndefined();
  expect(identity.headers.vary?.toLowerCase()).toContain("accept-encoding");
  expect(identity.body.equals(await readFile(file))).toBe(true);
  const head = await raw(url, "br", "HEAD");
  expect(head.headers["content-encoding"]).toBe("br");
  expect(head.body.length).toBe(0);
  const cached = await raw(url, "br", "GET", {
    "If-None-Match": String(head.headers.etag),
  });
  expect(cached.status).toBe(304);
  expect(cached.body.length).toBe(0);
  expect(cached.headers.vary?.toLowerCase()).toContain("accept-encoding");
});
test("first load makes only one external brand request; favicon uses the square mark", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests: string[] = [];
  page.on("request", (r) => {
    if (
      /\/brand\/yunqi-tower(?:-mark(?:-\d+)?)?\.(svg|png)$/.test(
        new URL(r.url()).pathname,
      )
    )
      requests.push(r.url());
  });
  await page.route("**/api/**", (r) => r.abort());
  await page.goto(base + "/?source=file");
  await expect(page.locator(".top-logo")).toBeVisible({ timeout: 20000 });
  expect(errors).toEqual([]);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  expect(requests).toHaveLength(1);
  const icon = await page
    .locator('link[rel="icon"][type="image/svg+xml"]')
    .getAttribute("href");
  expect(icon).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(
    Buffer.from(icon!.split(",")[1], "base64").equals(
      await readFile(path.join(root, "public/brand/yunqi-tower-mark.svg")),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(page.locator(".about-logo")).toBeVisible();
  expect(
    await page
      .locator(".about-logo")
      .evaluate(
        (e) =>
          (e as HTMLImageElement).complete &&
          (e as HTMLImageElement).naturalWidth > 0,
      ),
  ).toBe(true);
  expect(requests).toHaveLength(1);
});
