import { expect, it } from "vitest";
import {
  tooltipHour,
  tooltipNumber,
  seriesTooltip,
} from "../src/pages/energy/tooltips";
it("groups and rounds values, separates units but attaches percent", () => {
  expect(tooltipNumber(381.5224997184777, "kW")).toBe("381.5 kW");
  expect(tooltipNumber(12345.6789, "ppm")).toBe("12,346 ppm");
  expect(tooltipNumber(88.544, "%")).toBe("88.5%");
  expect(tooltipNumber(23.4432450758834, "℃")).toBe("23.4 ℃");
});
it("keeps power and temperature at one decimal, people and ppm at integers", () => {
  expect(tooltipNumber(500, "kW")).toBe("500.0 kW");
  expect(tooltipNumber(24, "℃")).toBe("24.0 ℃");
  expect(tooltipNumber(0, "kW")).toBe("0.0 kW");
  expect(tooltipNumber(-500, "kW")).toBe("-500.0 kW");
  expect(tooltipNumber(12345, "kW")).toBe("12,345.0 kW");
  expect(tooltipNumber(1234.56, "人")).toBe("1,235 人");
  expect(tooltipNumber(500, "ppm")).toBe("500 ppm");
  expect(tooltipNumber(52, "%")).toBe("52%");
  for (const unit of ["kW", "℃", "人", "ppm"])
    expect(tooltipNumber(NaN, unit)).toBe(`— ${unit}`);
  expect(
    seriesTooltip(
      [
        { seriesName: "在楼人数", value: [0, 1234.56] },
        { seriesName: "CO₂", value: [0, 500.49] },
      ],
      { 在楼人数: "人", "CO₂": "ppm" },
    ),
  ).toBe("00:00\n在楼人数  1,235 人\nCO₂  500 ppm");
});
it("uses axis-consistent clocks at and across midnight", () => {
  expect(tooltipHour(18)).toBe("18:00");
  expect(tooltipHour(0)).toBe("00:00");
  expect(tooltipHour(24)).toBe("次日 00:00");
  expect(tooltipHour(26)).toBe("次日 02:00");
  expect(tooltipHour(-1)).toBe("昨日 23:00");
});
it("formats multi-series and pie tooltips without raw numeric titles", () => {
  expect(
    seriesTooltip(
      [
        { seriesName: "北区", value: [18, 23.4432450758834] },
        { seriesName: "南区", value: [18, 25.555] },
      ],
      { default: "℃" },
    ),
  ).toBe("18:00\n北区  23.4 ℃\n南区  25.6 ℃");
  expect(
    seriesTooltip(
      {
        seriesName: "分项能耗",
        name: "空调",
        value: 654.2111,
        percent: 52.00001,
      },
      { default: "kW" },
      false,
    ),
  ).toBe("空调\n空调  654.2 kW · 52%");
  expect(
    seriesTooltip({ name: "22F", value: 1234.555 }, { default: "kW" }, false),
  ).toBe("22F\n22F  1,234.6 kW");
});
