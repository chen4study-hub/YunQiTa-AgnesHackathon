import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OverviewStatusText } from "../src/components/OverviewStatusText";
import { formatOverviewQuantities } from "../src/ui/overviewQuantity";

it("formats only quantities and keeps prices, timestamps and identifiers separate", () => {
  expect(
    formatOverviewQuantities(
      "BA设定 26 °C，EMS 0 kW；电量 13,875.94 kWh，电费 21,145 元；电价 1.20 元/kWh；14:00 #2026-1012-15；置信 90.25%",
    ),
  ).toBe(
    "BA设定 26.0 °C，EMS 0.0 kW；电量 13,875.9 kWh，电费 21,145.0 元；电价 1.20 元/kWh；14:00 #2026-1012-15；置信 90.25%",
  );
  const html = renderToStaticMarkup(
    <OverviewStatusText text="转交人工 · 0 kW · 26 °C · 21,145 元 · 1.20 元/kWh" />,
  );
  for (const value of ["0.0 kW", "26.0 °C", "21,145.0 元", "1.20 元/kWh"]) {
    expect(html).toContain(`<i class="overview-status-word">${value}</i>`);
  }
  expect(formatOverviewQuantities("负荷 -12.345 kW，温度 26℃")).toBe(
    "负荷 -12.3 kW，温度 26.0 ℃",
  );
});

it("wraps whole status words without changing surrounding text", () => {
  const text =
    "转交人工 · 已下发 · 待机 / 充电 / 放电 · 暂停自动下发 · 回执已记录";
  const html = renderToStaticMarkup(<OverviewStatusText text={text} />);
  expect(html.replace(/<[^>]*>/g, "")).toBe(text);
  for (const word of [
    "转交人工",
    "已下发",
    "待机",
    "充电",
    "放电",
    "暂停自动下发",
    "回执已记录",
  ]) {
    expect(html).toContain(`<i class="overview-status-word">${word}</i>`);
  }
});
