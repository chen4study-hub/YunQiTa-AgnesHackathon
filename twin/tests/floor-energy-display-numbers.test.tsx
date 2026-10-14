import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatNumber } from "../src/ui/numberFormat";
import { floorsNumber } from "../src/pages/floors/numbers";
import { energyNumber } from "../src/pages/energy/data";
import { tooltipNumber } from "../src/pages/energy/tooltips";
import { FloorLoadLegend } from "../src/pages/floors/FloorLoadChart";

describe("shared fixed-decimal display boundary", () => {
  it("keeps .0, grouping and invalid readings consistent with the public formatter", () => {
    for (const value of [26, 1277, 1234.25, -250, NaN]) {
      expect(floorsNumber(value, 1)).toBe(formatNumber(value, 1));
      expect(energyNumber(value, 1)).toBe(formatNumber(value, 1));
    }
    expect(floorsNumber(26, 1)).toBe("26.0");
    expect(energyNumber(1277, 1)).toBe("1,277.0");
    expect(energyNumber(null, 1)).toBe("—");
  });
  it("leaves integer coordinates and counts unchanged", () => {
    expect(floorsNumber(1000)).toBe("1,000");
    expect(energyNumber(1000)).toBe("1,000");
  });
  it("uses one decimal for measurement and cost tooltips, including integer inputs", () => {
    for (const unit of ["kW", "kWh", "元", "℃", "°C"])
      expect(tooltipNumber(1277, unit)).toBe(`1,277.0 ${unit}`);
    expect(tooltipNumber(1000, "ppm")).toBe("1,000 ppm");
    expect(tooltipNumber(35, "%")).toBe("35%");
  });
  it("uses the public formatter for floor legend text and titles", () => {
    const html = renderToStaticMarkup(
      <FloorLoadLegend scale={{ p10: 10, p50: 1000, p90: 1200.5 }} />,
    );
    expect(html).toContain("10.0 kW");
    expect(html).toContain("1,000.0 kW");
    expect(html).toContain("1,200.5 kW");
  });
});
