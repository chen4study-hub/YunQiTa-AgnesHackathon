import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
describe("shared floor and energy typography", () => {
  it("keeps brighter shaft labels and stopped-car text scoped to mobile", () => {
    const css = readFileSync("src/pages/floors/floors.css", "utf8");
    const mobile = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(mobile).toContain("--floors-shaft-text: #d4e4ed");
    expect(mobile).toContain("--floors-car-text: #e4ecf1");
    expect(mobile).toContain("background: var(--floors-shaft-label-bg)");
    expect(mobile).toContain('[data-status="doors"]');
    expect(mobile).toContain('[data-status="idle"]');
    expect(mobile).toContain("color: var(--floors-car-text)");
  });
  it("reserves enough height for the desktop temperature plot", () => {
    const css = readFileSync("src/pages/floors/floors.css", "utf8");
    expect(css).toMatch(
      /\.floors-page \.floors-temperature-chart\s*\{[^}]*min-height: 200px/,
    );
    expect(css).toContain("(min-width: 1201px) and (max-width: 1600px)");
  });
  it("uses shared type tokens instead of page-local sizes", () => {
    for (const path of [
      "src/pages/floors/floors.css",
      "src/pages/energy/energy.css",
    ]) {
      const css = readFileSync(path, "utf8");
      expect(css).not.toMatch(
        /--(?:floors-value-size|energy-value-size|energy-center-size|energy-summary-size)/,
      );
      for (const token of [
        "--font-title",
        "--font-subtitle",
        "--font-value-md",
        "--font-unit",
        "--font-note",
      ])
        expect(css).toContain(token);
      // Compact SOC caption and thermostat line have approved 10px minima.
      const literalSizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map(m=>Number(m[1]));
      expect(literalSizes.every(size=>size===10)).toBe(true);
      expect(css).not.toMatch(/font-size:\s*clamp/);
    }
  });
});
