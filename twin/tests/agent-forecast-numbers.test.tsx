import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import { formatPageNumber } from "../src/pages/displayNumbers";
import {
  n,
  pct,
  elapsedMs,
  recentHours,
  replayDecision,
} from "../src/pages/agent/data";
import {
  number,
  percent,
  modelRows,
  timeLabel,
} from "../src/pages/forecast/data";
import { forecastView } from "../src/pages/forecast/data";
import {
  forecastOption,
  confidenceOption,
  floorOption,
} from "../src/pages/forecast/charts";
import { candidateOption } from "../src/pages/agent/charts";
import { RecordTable } from "../src/pages/agent/RecordTable";
const data = () =>
  JSON.parse(readFileSync("public/replay/normal.json", "utf8")) as ReplayData;
it("both pages share one bounded, grouped formatter without changing source precision", () => {
  expect(n(12345.678)).toBe("12,345.7");
  expect(number(12345.678)).toBe(n(12345.678));
  expect(n(12)).toBe("12.0");
  expect(number(12.0345, 2)).toBe("12.0");
  expect(pct(0.95)).toBe("95.0%");
  expect(percent(0.837)).toBe("83.7%");
  for (const [input, output] of [
    [3.71, "3.7 ms"],
    [0.936, "0.9 ms"],
    [9.99, "10.0 ms"],
    [10, "10 ms"],
    [12.8, "13 ms"],
    [1234.56, "1,235 ms"],
  ] as const)
    expect(elapsedMs(input)).toBe(output);
  expect(formatPageNumber(-0.00001)).toBe("0.0");
  expect(formatPageNumber(NaN)).toBe("—");
  const card = JSON.parse(
    readFileSync("public/replay/model_card.json", "utf8"),
  );
  card.retained_mae = 42.651;
  expect(modelRows(card).find((r) => r.key === "retained_mae")?.value).toBe(
    "42.7 kW",
  );
  expect(card.retained_mae).toBe(42.651);
});
it("yesterday rows use corresponding source hours, retain source keys and skip non-executed latency", () => {
  const replay = data();
  const previous = JSON.parse(
    readFileSync("public/replay/abstain.json", "utf8"),
  ) as ReplayData;
  expect(recentHours(replay, 2).map((r) => r.index)).toEqual([0, 1, 2]);
  const rows = recentHours(replay, 2, previous);
  expect(rows.map((r) => r.index)).toEqual([21, 22, 23, 0, 1, 2]);
  expect(
    rows.slice(0, 3).map((r) => timeLabel(r.t, replay.hours[2].t)),
  ).toEqual(["昨日 21:00", "昨日 22:00", "昨日 23:00"]);
  expect(rows[0].hour).toBe(previous.hours[21]);
  const current = replayDecision(replay, 2);
  current.handoff = true;
  current.receipt.elapsed = 0;
  const html = renderToStaticMarkup(
    <RecordTable
      data={replay}
      previous={previous}
      index={2}
      current={current}
      statuses={{}}
    />,
  );
  expect(html).not.toContain("该时段记录未提供");
  expect(html).toContain(`data-record-t="${previous.hours[23].t}"`);
  expect(html).toContain('aria-label="—"');
  expect(html).not.toContain("0.000 ms");
  expect(html).not.toMatch(/\d\.\d{3,}/);
  expect(current.receipt.elapsed).toBe(0);
});

it("integer physical values retain .0 on both pages while counts remain integers", () => {
  for (const value of [0, 26, 250, 1047, 7428, -365]) {
    const expected = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
    expect(formatPageNumber(value)).toBe(expected);
    expect(n(value)).toBe(expected);
    expect(number(value)).toBe(expected);
  }
  expect(n(3, 0)).toBe("3");
  expect(number(40, 0)).toBe("40");
});

it("chart ticks are integers while tooltip readings keep one decimal", () => {
  const replay = data(),
    view = forecastView(replay, 14);
  const forecast = forecastOption(view) as any;
  expect(forecast.yAxis.axisLabel.formatter(1400)).toBe("1,400");
  expect(
    forecast.tooltip.formatter([{ seriesName: "预测", dataIndex: 1 }]),
  ).toContain(`${number(view.forecast_24h[0].point_kw)} kW`);
  const confidence = confidenceOption(view) as any;
  expect(confidence.yAxis.axisLabel.formatter(89.4)).toBe("89%");
  expect(confidence.tooltip.formatter({ dataIndex: 0 })).toContain(
    percent(view.forecast_24h[0].confidence),
  );
  const floors = floorOption([26]) as any;
  expect(floors.yAxis.axisLabel.formatter(26)).toBe("26");
  expect(floors.tooltip.formatter({ dataIndex: 0 })).toContain("26.0 kW");
  const candidate = candidateOption(replayDecision(replay, 14)) as any;
  expect(candidate.xAxis.axisLabel.formatter(7428)).toBe("7,428");
  expect(candidate.tooltip.valueFormatter(7428)).toBe("7,428.0");
});
