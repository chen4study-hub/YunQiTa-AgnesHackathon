import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("square favicon, raster sizes, small-size outlines and one first-load brand request", async ({
  page,
}, info) => {
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
  await page.goto("/?source=file&at=2026-10-12T18:31");
  await expect(page.locator(".top-logo")).toBeVisible();
  await page.waitForTimeout(500);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).pathname).toBe("/brand/yunqi-tower.svg");
  const href = (await page
    .locator('link[rel="icon"][type="image/svg+xml"]')
    .getAttribute("href"))!;
  expect(href).toMatch(/^data:image\/svg\+xml;base64,/);
  const mark = await readFile(
    new URL("../public/brand/yunqi-tower-mark.svg", import.meta.url),
    "utf8",
  );
  expect(Buffer.from(href.split(",")[1], "base64").toString()).toBe(mark);
  await expect(
    page.locator('link[rel="icon"][type="image/png"]'),
  ).toHaveAttribute("sizes", "32x32");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "sizes",
    "180x180",
  );
  // Brand images keep the original wordmark and share the single fetched asset.
  await page.getByRole("button", { name: "关于", exact: false }).click();
  await expect(page.locator(".about-logo")).toHaveAttribute(
    "src",
    "/brand/yunqi-tower.svg",
  );
  expect(requests).toHaveLength(1);
  for (const size of [32, 180]) {
    const comparison = await page.evaluate(
      async ({ href, size }) => {
        const svg = new Image(),
          png = new Image();
        svg.src = href;
        png.src = `/brand/yunqi-tower-mark-${size}.png`;
        await Promise.all([svg.decode(), png.decode()]);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(svg, 0, 0, size, size);
        const source = ctx.getImageData(0, 0, size, size).data;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(png, 0, 0);
        const raster = ctx.getImageData(0, 0, size, size).data;
        return {
          width: png.naturalWidth,
          height: png.naturalHeight,
          equal: source.every((value, index) => value === raster[index]),
        };
      },
      { href, size },
    );
    expect(comparison).toEqual({ width: size, height: size, equal: true });
  }
  // Render at native tab sizes on both backgrounds, plus enlarged nearest-neighbor samples.
  await page.setContent(
    `<style>body{margin:0;padding:16px;background:#8597a3;font:13px sans-serif}.row{display:flex;align-items:center;gap:24px;padding:16px;margin-bottom:12px}img{display:block}.light{background:#f2f2f2;color:#111}.dark{background:#202124;color:#fff}.zoom{image-rendering:pixelated}</style>${["light", "dark"].map((theme) => `<div class="row ${theme}"><span>${theme}</span>${[16, 32].map((size) => `<img class="native" width="${size}" height="${size}" src="${href}"><img class="zoom" width="128" height="128" data-size="${size}">`).join("")}</div>`).join("")}`,
  );
  const pixels = await page.evaluate(async (href) => {
    const image = new Image();
    image.src = href;
    await image.decode();
    // Isolate the exact tower silhouette; the tile/rim must not inflate its bounds.
    const xml = atob(href.split(",")[1]);
    const tower = new Image();
    tower.src =
      "data:image/svg+xml;base64," + btoa(xml.replace(/<rect[^>]*\/>/, ""));
    await tower.decode();
    const results = [];
    for (const size of [16, 32, 180]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0, size, size);
      document
        .querySelectorAll<HTMLImageElement>(`[data-size="${size}"]`)
        .forEach((img) => (img.src = canvas.toDataURL()));
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(tower, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      const xs: number[] = [],
        ys: number[] = [];
      let spirePixels = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          if (data[i + 3] > 20) {
            xs.push(x);
            ys.push(y);
            if (y < size * 0.24) spirePixels++;
          }
        }
      const width = Math.max(...xs) - Math.min(...xs) + 1,
        height = Math.max(...ys) - Math.min(...ys) + 1;
      results.push({
        size,
        width,
        height,
        spirePixels,
        centerX: (Math.min(...xs) + Math.max(...xs) + 1) / 2,
        centerY: (Math.min(...ys) + Math.max(...ys) + 1) / 2,
      });
    }
    return results;
  }, href);

  for (const sample of pixels) {
    expect(sample.height / sample.size).toBeGreaterThanOrEqual(0.84);
    expect(sample.height / sample.size).toBeLessThanOrEqual(0.94); // small raster antialiasing adds at most one pixel
    expect(sample.height / sample.width).toBeGreaterThanOrEqual(
      sample.size === 16 ? 2.2 : 2.8,
    );
    expect(sample.height / sample.width).toBeLessThan(4.2);
    expect(Math.abs(sample.centerX - sample.size / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(sample.centerY - sample.size / 2)).toBeLessThanOrEqual(1);
    expect(sample.spirePixels).toBeGreaterThan(0);
  }

  await page.screenshot({
    path: info.outputPath("favicon-native-and-zoom.png"),
  });
});
