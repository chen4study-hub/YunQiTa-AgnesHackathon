import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
const css = readFileSync(
  new URL("../src/ui/typography.css", import.meta.url),
  "utf8",
);
it("publishes pixel-based readability tokens independent of layout rem sizes", () => {
  for (const [name, value] of Object.entries({
    body: "15px",
    table: "14px",
    note: "14px",
    label: "12px",
    legend: "12px",
    title: "clamp(18px, 1vw, 20px)",
  }))
    expect(css).toContain(`--font-${name}: ${value}`);
  expect(css).toMatch(
    /@media\s*\(max-width: 1366px\)[\s\S]*?--font-body: 14px/,
  );
  expect(css).toContain("--font-subtitle: var(--font-note)");
  expect(css).toContain("--font-unit: max(12px, 0.45em)");
});
it("keeps public scopes token-bound without reaching into page-team selectors", () => {
  expect(css).toContain("font-size: var(--font-table) !important");
  for (const forbidden of [
    ".agent-page",
    ".forecast-page",
    ".energy-page",
    ".floors-page",
  ])
    expect(css).not.toContain(forbidden);
});
