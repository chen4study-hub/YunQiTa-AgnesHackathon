import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { candidateOption } from "../src/pages/agent/charts";
import { replayDecision } from "../src/pages/agent/data";
import type { ReplayData } from "../src/data/types";

describe("Agent and forecast shared typography", () => {
  it("routes page-local sizes through the public type hierarchy", () => {
    for (const path of [
      "src/pages/agent/agent.css",
      "src/pages/forecast/forecast.css",
    ]) {
      const css = readFileSync(path, "utf8");
      for (const token of [
        "--font-title",
        "--font-subtitle",
        "--font-value-md",
        "--font-unit",
        "--font-note",
      ])
        expect(css).toContain(token);
      for (const [, value] of css.matchAll(/font-size:\s*([^;]+);/g)) {
        expect(value === "inherit" || value.includes("var(--font-")).toBe(true);
      }
      expect(css).toContain("font-size: var(--font-unit)");
    }
  });
  it("keeps the currency unit in the heading instead of beside bar value labels", () => {
    const data = JSON.parse(
      readFileSync("public/replay/normal.json", "utf8"),
    ) as ReplayData;
    expect(candidateOption(replayDecision(data, 14)).xAxis).toMatchObject({
      name: "",
    });
  });
});
