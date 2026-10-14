import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const towerRules = Object.freeze({
  floors: 10,
  twist: 78,
  baseSide: 22,
  topRatio: 2 / 3,
  thickness: 5.5,
  gap: 2,
  elevation: 12,
  azimuth: 40,
  axisX: 48,
  baseY: 100,
  spireHeight: (10 * 5.5 + 9 * 2) / 4,
});
export const towerColors = Object.freeze({
  left: "#ECF4F8",
  front: "#4FD1D9",
  right: "#18606E",
  recess: "#16303D",
  beacon: "#FF6A3D",
});
const rad = (degrees) => (degrees * Math.PI) / 180;
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const rotate = ([x, y], angle) => [
  x * Math.cos(angle) - y * Math.sin(angle),
  x * Math.sin(angle) + y * Math.cos(angle),
];
const number = (value) => Number(value.toFixed(4)).toString();
const points = (vertices) =>
  vertices.map((p) => p.map(number).join(",")).join(" ");

export function project([x, y, z], rules = towerRules) {
  const azimuth = rad(rules.azimuth),
    elevation = rad(rules.elevation);
  const depth = x * Math.sin(azimuth) + y * Math.cos(azimuth);
  return [
    rules.axisX + x * Math.cos(azimuth) - y * Math.sin(azimuth),
    rules.baseY - z * Math.cos(elevation) + depth * Math.sin(elevation),
  ];
}
/** Continuous direction shading: left (-45°) → front (0°) → right (+45°).
 * Both faces reuse their common vertex's normal/color, including the seam. */
export function sideColor(angle) {
  const u = Math.max(-1, Math.min(1, angle / (Math.PI / 4)));
  const a = u < 0 ? towerColors.left : towerColors.front;
  const b = u < 0 ? towerColors.front : towerColors.right;
  const t = u < 0 ? u + 1 : u;
  const smooth = t * t * (3 - 2 * t);
  const rgb = (hex) =>
    hex
      .slice(1)
      .match(/../g)
      .map((channel) => parseInt(channel, 16));
  return (
    "#" +
    rgb(a)
      .map((v, i) =>
        Math.round(v + (rgb(b)[i] - v) * smooth)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  );
}
export function buildTower(rules = towerRules) {
  const azimuth = rad(rules.azimuth);
  const view = [Math.sin(azimuth), Math.cos(azimuth)];
  const right = [Math.cos(azimuth), -Math.sin(azimuth)];
  return Array.from({ length: rules.floors }, (_, i) => {
    const fraction = i / (rules.floors - 1);
    const degrees = -4 + rules.twist * fraction;
    const angle = rad(degrees);
    const side = rules.baseSide * (1 - (1 - rules.topRatio) * fraction);
    const z = i * (rules.thickness + rules.gap);
    // CCW square, rotated about (0,0) at every level; no horizontal axis drift.
    const plan = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map((p) =>
      rotate(
        p.map((v) => (v * side) / 2),
        angle,
      ),
    );
    const bottom3d = plan.map(([x, y]) => [x, y, z]);
    const top3d = plan.map(([x, y]) => [x, y, z + rules.thickness]);
    const bottom = bottom3d.map((p) => project(p, rules));
    const top = top3d.map((p) => project(p, rules));
    const faces = [];
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      const normal = [
        plan[next][1] - plan[edge][1],
        plan[edge][0] - plan[next][0],
      ];
      if (dot(normal, view) <= 0) continue; // only the two audience-facing sides
      const stops = Array.from({ length: 9 }, (_, j) => {
        const t = j / 8;
        const n = plan[edge].map((v, k) => v * (1 - t) + plan[next][k] * t);
        const direction = Math.atan2(dot(n, right), dot(n, view));
        return { offset: t, color: sideColor(direction) };
      });
      faces.push({
        edge,
        next,
        vertices: [top[edge], top[next], bottom[next], bottom[edge]],
        stops,
      });
    }
    return { i, degrees, side, z, bottom3d, top3d, top, bottom, faces };
  });
}

// Preserve the original wordmark's text, placement, fonts and letter spacing.
export const wordmark =
  '<text x="104" y="63" fill="#e4ecf1" font-family="Microsoft YaHei, sans-serif" font-size="42" font-weight="700" letter-spacing="4">云栖塔</text><text x="106" y="87" fill="#8ba9b9" font-family="sans-serif" font-size="13" letter-spacing="5">YUNQI TOWER</text>';
export function generateLogo(rules = towerRules) {
  const floors = buildTower(rules);
  const gradients = floors
    .flatMap((floor) =>
      floor.faces.map((face) => {
        const [a, b] = face.vertices;
        return `<linearGradient id="side-${floor.i}-${face.edge}" gradientUnits="userSpaceOnUse" x1="${number(a[0])}" y1="0" x2="${number(b[0])}" y2="0">${face.stops.map((stop) => `<stop offset="${number(stop.offset)}" stop-color="${stop.color}"/>`).join("")}</linearGradient>`;
      }),
    )
    .join("\n");
  const slabs = floors
    .map(
      (floor) =>
        `<g data-floor="${floor.i}" data-angle="${number(floor.degrees)}"><polygon data-face="top" points="${points(floor.top)}" fill="${floor.i === rules.floors - 1 ? towerColors.front : towerColors.recess}"/>${floor.faces.map((face) => `<polygon data-face="side" points="${points(face.vertices)}" fill="url(#side-${floor.i}-${face.edge})"/>`).join("")}</g>`,
    )
    .join("\n");
  const z = floors.at(-1).z + rules.thickness;
  const base = project([0, 0, z]),
    tip = project([0, 0, z + rules.spireHeight]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 110" role="img" aria-labelledby="title"><title id="title">云栖塔 · YUNQI TOWER</title>\n<!-- Generated by scripts/generate-logo.mjs; edit geometry rules, not polygons. -->\n<defs>\n${gradients}\n</defs>\n<g id="tower">\n${slabs}\n<path d="M${points([base, tip]).replace(" ", " L")}" fill="none" stroke="${towerColors.front}" stroke-width="1"/><circle cx="${number(tip[0])}" cy="${number(tip[1])}" r="1.5" fill="${towerColors.beacon}"/>\n</g>\n${wordmark}</svg>\n`;
}
/** Tower-only mark: identical slabs, twist, taper, shading and spire as the wordmark.
 * Uniform scaling preserves the original slender silhouette, without widening. */
export function towerMarkLayout() {
  const floors = buildTower();
  const top = floors.at(-1);
  const tip = project([
    0,
    0,
    top.z + towerRules.thickness + towerRules.spireHeight,
  ]);
  const vertices = floors.flatMap((f) => [...f.top, ...f.bottom]);
  const minY = tip[1] - 1.5;
  const maxY = Math.max(...vertices.map((p) => p[1]));
  const minX = Math.min(...vertices.map((p) => p[0]));
  const maxX = Math.max(...vertices.map((p) => p[0]));
  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    scale: 112 / (maxY - minY),
  };
}
export function generateTowerMark() {
  const logo = generateLogo();
  const artwork = logo.slice(logo.indexOf("<defs>"), logo.indexOf(wordmark));
  const layout = towerMarkLayout();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="mark-title"><title id="mark-title">云栖塔塔形图标</title>
<!-- Generated by scripts/generate-logo.mjs; exact brand tower geometry, uniform scale. -->
<rect x="1" y="1" width="126" height="126" rx="20" fill="#0B1720" stroke="${towerColors.front}" stroke-width="2"/>
<g transform="translate(64 64) scale(${number(layout.scale)}) translate(${number(-layout.centerX)} ${number(-layout.centerY)})">
${artwork}</g></svg>\n`;
}
/** Rasterize the generated SVG with the project's existing browser dependency. */
export async function writeMarkPngs(svg) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await browser.newPage();
    for (const size of [32, 180]) {
      const png = await page.evaluate(
        async ({ svg, size }) => {
          const image = new Image();
          image.src =
            "data:image/svg+xml;base64," +
            btoa(unescape(encodeURIComponent(svg)));
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          canvas.getContext("2d").drawImage(image, 0, 0, size, size);
          return canvas.toDataURL("image/png").split(",")[1];
        },
        { svg, size },
      );
      const target = fileURLToPath(
        new URL(
          `../public/brand/yunqi-tower-mark-${size}.png`,
          import.meta.url,
        ),
      );
      writeFileSync(target, Buffer.from(png, "base64"));
      console.log(`Generated ${target}`);
    }
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv.includes("--mark-only")) {
    const destination = fileURLToPath(
      new URL("../public/brand/yunqi-tower.svg", import.meta.url),
    );
    writeFileSync(destination, generateLogo());
    console.log(`Generated ${destination} (10 slabs, 78° twist, 2/3 taper)`);
  }
  const mark = generateTowerMark();
  const target = fileURLToPath(
    new URL("../public/brand/yunqi-tower-mark.svg", import.meta.url),
  );
  writeFileSync(target, mark);
  console.log(`Generated ${target}`);
  await writeMarkPngs(mark);
}
