import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeEol } from "./normalize-eol.mjs";
import {
  buildTower,
  generateLogo,
  generateTowerMark,
  towerMarkLayout,
  project,
  sideColor,
  towerRules,
  towerColors,
  wordmark,
} from "../scripts/generate-logo.mjs";

it("stacks ten planar square slabs on one vertical axis with 78 degree twist and 2/3 taper", () => {
  const floors = buildTower();
  expect(floors).toHaveLength(10);
  expect(floors.at(-1).degrees - floors[0].degrees).toBeCloseTo(78);
  expect(floors.at(-1).side / floors[0].side).toBeCloseTo(2 / 3);
  for (const floor of floors) {
    for (const ring of [floor.top3d, floor.bottom3d]) {
      expect(ring.reduce((v, p) => v + p[0], 0)).toBeCloseTo(0);
      expect(ring.reduce((v, p) => v + p[1], 0)).toBeCloseTo(0);
      expect(new Set(ring.map((p) => p[2])).size).toBe(1);
      for (let j = 0; j < 4; j++)
        expect(
          Math.hypot(
            ...ring[j].slice(0, 2).map((v, k) => v - ring[(j + 1) % 4][k]),
          ),
        ).toBeCloseTo(floor.side);
    }
    if (floor.i > 0) {
      expect(floor.degrees - floors[floor.i - 1].degrees).toBeCloseTo(78 / 9);
      expect(floor.z - floors[floor.i - 1].top3d[0][2]).toBeCloseTo(
        towerRules.gap,
      );
    }
  }
});
it("is slender, thick and visibly separated at 40px with a quarter-height spire", () => {
  const floors = buildTower();
  const bottom = floors[0].bottom,
    top = floors.at(-1).top;
  const width =
    Math.max(...bottom.map((p) => p[0])) - Math.min(...bottom.map((p) => p[0]));
  const height =
    Math.max(...bottom.map((p) => p[1])) - Math.min(...top.map((p) => p[1]));
  expect(height / width).toBeGreaterThan(2.3);
  expect(height / width).toBeLessThan(2.7);
  const scale = 40 / 110,
    cosine = Math.cos((towerRules.elevation * Math.PI) / 180);
  expect(towerRules.thickness * cosine * scale).toBeGreaterThan(1.8);
  expect(towerRules.gap * cosine * scale).toBeGreaterThan(0.65);
  expect(
    towerRules.spireHeight / (floors.at(-1).z + towerRules.thickness),
  ).toBeCloseTo(0.25);
});
it("uses precisely two visible sides and shares exact vertices and seam colors with each top", () => {
  for (const floor of buildTower()) {
    expect(floor.faces).toHaveLength(2);
    for (const face of floor.faces) {
      expect(face.vertices[0]).toBe(floor.top[face.edge]);
      expect(face.vertices[1]).toBe(floor.top[face.next]);
      expect(face.vertices[2]).toBe(floor.bottom[face.next]);
      expect(face.vertices[3]).toBe(floor.bottom[face.edge]);
      expect(face.stops).toHaveLength(9);
    }
    const [a, b] = floor.faces;
    const shared = [a.edge, a.next].find(
      (index) => index === b.edge || index === b.next,
    );
    const endpoint = (face) =>
      shared === face.edge ? face.stops[0].color : face.stops.at(-1).color;
    expect(endpoint(a)).toBe(endpoint(b));
  }
});
it("shades continuously by direction using the requested anchors", () => {
  expect(sideColor(-Math.PI / 4)).toBe(towerColors.left);
  expect(sideColor(0)).toBe(towerColors.front);
  expect(sideColor(Math.PI / 4)).toBe(towerColors.right);
  const channels = (hex) =>
    hex
      .slice(1)
      .match(/../g)
      .map((v) => parseInt(v, 16));
  for (let step = -89; step <= 90; step++) {
    const a = channels(sideColor(((step - 1) * Math.PI) / 180)),
      b = channels(sideColor((step * Math.PI) / 180));
    expect(
      Math.max(...a.map((v, i) => Math.abs(v - b[i]))),
    ).toBeLessThanOrEqual(8);
  }
});
it("is reproducibly generated, fits the viewBox, preserves the wordmark and centers the beacon", () => {
  const svg = generateLogo();
  expect(
    normalizeEol(
      readFileSync(new URL("../public/brand/yunqi-tower.svg", import.meta.url)),
    ).equals(normalizeEol(svg)),
  ).toBe(true);
  expect(svg).toContain(wordmark);
  expect(svg.match(/data-face="top"/g)).toHaveLength(10);
  expect(svg.match(/data-face="side"/g)).toHaveLength(20);
  expect(svg).toContain('fill="#FF6A3D"');
  for (const floor of buildTower())
    for (const p of [...floor.top, ...floor.bottom]) {
      expect(p[0]).toBeGreaterThan(0);
      expect(p[0]).toBeLessThan(104);
      expect(p[1]).toBeGreaterThan(0);
      expect(p[1]).toBeLessThan(110);
    }
  const last = buildTower().at(-1);
  const tip = project([
    0,
    0,
    last.z + towerRules.thickness + towerRules.spireHeight,
  ]);
  expect(tip[0]).toBe(towerRules.axisX);
  expect(tip[1]).toBeGreaterThan(0);
  expect(svg).toContain(`cx="${towerRules.axisX}"`);
});

it("generates a tower-only square mark from the unchanged brand geometry", () => {
  const mark = generateTowerMark(),
    logo = generateLogo();
  expect(
    normalizeEol(
      readFileSync(
        new URL("../public/brand/yunqi-tower-mark.svg", import.meta.url),
      ),
    ).equals(normalizeEol(mark)),
  ).toBe(true);
  expect(mark).toContain('viewBox="0 0 128 128"');
  expect(mark).not.toContain("<text");
  expect(mark).not.toContain(wordmark);
  const artwork = logo.slice(logo.indexOf("<defs>"), logo.indexOf(wordmark));
  expect(mark).toContain(artwork);
  expect(mark.match(/data-floor=/g)).toHaveLength(10);
  const layout = towerMarkLayout();
  expect(((layout.maxY - layout.minY) * layout.scale) / 128).toBeCloseTo(0.875);
  expect(64 + (layout.minY - layout.centerY) * layout.scale).toBeCloseTo(8);
  expect(64 + (layout.maxY - layout.centerY) * layout.scale).toBeCloseTo(120);
  expect(64 + (layout.minX - layout.centerX) * layout.scale).toBeCloseTo(
    128 - (64 + (layout.maxX - layout.centerX) * layout.scale),
  );
  const scale = mark.match(/scale\(([^)]+)\)/)[1];
  expect(scale.trim().split(/\s+/)).toHaveLength(1);
  expect(Number(scale)).toBeCloseTo(layout.scale, 4);
  for (const size of [32, 180]) {
    const png = readFileSync(
      new URL(`../public/brand/yunqi-tower-mark-${size}.png`, import.meta.url),
    );
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
});
