import { setTimelineHour } from "./timeline-helper";
import { test, expect } from "@playwright/test";
import { isolateOpsTest } from "./ops-test-data";
test.beforeEach(async ({ page }) => isolateOpsTest(page));
import { inflateSync } from "node:zlib";

// Decode the browser's actual PNG pixels (RGB/RGBA, non-interlaced), no new dependency.
function pngPixel(png: Buffer, x: number, y: number): number[] {
  const chunks: Buffer[] = [];
  let width = 0,
    height = 0,
    channels = 0;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[12]).toBe(0);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      expect(channels).toBeGreaterThan(0);
    }
    if (type === "IDAT") chunks.push(data);
    offset += length + 12;
  }
  expect(x).toBeLessThan(width);
  expect(y).toBeLessThan(height);
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let row = 0; row <= y; row++) {
    const start = row * (stride + 1),
      filter = raw[start];
    const current = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? current[i - channels] : 0;
      const b = previous[i],
        c = i >= channels ? previous[i - channels] : 0;
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : paeth(a, b, c);
      current[i] = (raw[start + 1 + i] + prediction) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

test("playing selection overlay preserves valley, peak and rejection center pixels", async ({
  page,
}) => {
  await page.goto("/?source=mock&at=2026-10-12T00:00");
  await expect(page.locator(".twin-scene canvas")).toBeVisible();
  for (const [date, hour, color, alpha] of [
    ["2026-10-12", 1, [47, 191, 143], 68 / 255],
    ["2026-10-12", 12, [255, 106, 61], 68 / 255],
    ["2026-10-01", 10, [255, 77, 94], 136 / 255],
  ] as const) {
    await page.goto(`/?source=mock&at=${date}T00:00`);
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
    await setTimelineHour(page, hour);
    await expect(page.locator(".timeline")).toHaveAttribute(
      "data-time",
      String(hour),
    );
    await page.getByRole("button", { name: "▶ 播放", exact: true }).click();
    await page.waitForTimeout(300);
    const cell = page.locator(`.timeline [data-hour="${hour}"]`);
    const box = (await cell.boundingBox())!;
    const png = await page.screenshot();
    const actual = pngPixel(
      png,
      Math.floor(box.x + box.width / 2),
      Math.floor(box.y + box.height / 2),
    );
    const expected = color.map((channel, i) =>
      Math.round(channel * alpha + [12, 19, 27][i] * (1 - alpha)),
    );
    expect(
      actual,
      `hour ${hour}: expected semantic color ${expected}`,
    ).not.toEqual([12, 19, 27]);
    actual.forEach((channel, i) =>
      expect(
        Math.abs(channel - expected[i]),
        `${actual} vs ${expected}`,
      ).toBeLessThan(18),
    );
    expect(
      await page
        .locator(".timeline-slider")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      await page
        .locator(".timeline-slider")
        .evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe("none");
    await page.getByRole("button", { name: "Ⅱ 暂停", exact: true }).click();
  }
});
