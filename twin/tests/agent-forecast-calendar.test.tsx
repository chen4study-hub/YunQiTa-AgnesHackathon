import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import { ForecastContent } from "../src/pages/forecast/ForecastContent";
import { forecastView } from "../src/pages/forecast/data";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
import { ChatPanel } from "../src/pages/agent/ChatPanel";
import { replayDecision } from "../src/pages/agent/data";
import { replayCalendar } from "../src/ui/replayCalendar";
import { formatDisplayDate } from "../src/config/presentation";
import { timeLabel, shiftTime } from "../src/pages/forecast/data";
import { forecastOption } from "../src/pages/forecast/charts";
import { RecordTable } from "../src/pages/agent/RecordTable";
const data = (scenario: string) =>
  JSON.parse(
    readFileSync(`public/replay/${scenario}.json`, "utf8"),
  ) as ReplayData;
it("both pages use injected local dates independently of the hidden replay route and identify historical data", () => {
  for (const scenario of ["normal", "peak", "abstain"])
    for (const hour of [0, 9, 23]) {
      const replay = data(scenario),
        nowMs = new Date(2026, 9, 12, hour, 23, 5).getTime(),
        decision = replayDecision(replay, hour);
      const forecast = renderToStaticMarkup(
        <ForecastContent
          view={forecastView(replay, hour)}
          current={replay.hours[hour]}
          floors={replay.hours[hour].floors_kw}
          modelCard={null}
          scenario={scenario}
          nowMs={nowMs}
        />,
      );
      expect(forecast).toContain(formatDisplayDate(nowMs));
      expect(forecast).toContain("滚动预测 · 24h");
      expect(forecast).toContain("原始观测");
      const agent = renderToStaticMarkup(
        <DecisionCard
          data={replay}
          index={hour}
          decision={decision}
          online={false}
          pending={false}
          onAction={() => {}}
          displayText={replayCalendar(scenario, decision.t, nowMs).text}
        />,
      );
      const chat = renderToStaticMarkup(
        <ChatPanel
          data={replay}
          index={hour}
          scenario={scenario}
          decision={decision}
          nowMs={nowMs}
        />,
      );
      for (const html of [forecast, agent, chat])
        expect(html.replace(/<[^>]*>/g, "")).not.toMatch(
          /典型日|代表日|情景|高温日|节假日|回放|模拟|估算|估计|影子模式|演示|推算|沿用|非实测|待人工确认|2016[-年/]|2017[-年/]/,
        );
      expect(chat).toContain("选择快捷问题，或直接输入运维问题。");
      for (const html of [chat, agent])
        expect(html).not.toMatch(
          /游标|不是今天的实时测量|原始观测不代表今天的实时测量|BA\/EMS 为调度日志|服务端处理问题；离线模式/,
        );
    }
});
it("cross-midnight chart ticks and records are relative to the footer current date, not playback start", () => {
  const replay = data("normal");
  const t = replay.hours[1].t,
    labelOrigin = t;
  expect(timeLabel(t, labelOrigin)).toBe("01:00");
  expect(timeLabel(shiftTime(t, -2), labelOrigin)).toBe("昨日 23:00");
  expect(timeLabel(shiftTime(t, 24), labelOrigin)).toBe("次日 01:00");
  const view = forecastView(replay, 1);
  const option = forecastOption(view, labelOrigin);
  const x = option.xAxis as { axisLabel: { formatter: (n: number) => string } };
  expect(x.axisLabel.formatter(0)).toBe("01:00");
  const html = renderToStaticMarkup(
    <RecordTable
      data={replay}
      index={1}
      current={replayDecision(replay, 1)}
      statuses={{}}
      labelOrigin={labelOrigin}
    />,
  );
  expect(html).toContain("00:00");
  expect(html).toContain("截至 01:00");
  expect(html).not.toMatch(/次日|后日/);
  expect(replay.hours[1].t).toBe(t);
});
it("page-owned date adapters receive state.nowMs rather than fixed calendar dates", () => {
  for (const file of [
    "src/pages/AgentPage.tsx",
    "src/pages/ForecastPage.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("Math.floor(state.time)");
    expect(source).toContain("state.nowMs");
    expect(source).not.toMatch(
      /14:00|2026-05-19|formatDisplayDate\(state.scenario\)/,
    );
  }
});
