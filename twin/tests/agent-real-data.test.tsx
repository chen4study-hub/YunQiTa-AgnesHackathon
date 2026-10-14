import { it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReplayData } from "../src/data/types";
import { ReplayFileAdapter } from "../src/data/adapters";
import {
  replayDecision,
  scheduleDecision,
  recentHours,
  n,
  storagePower,
  storageLabel,
} from "../src/pages/agent/data";
import { loadPreviousDay } from "../src/pages/agent/record-history";
import { DecisionCard } from "../src/pages/agent/DecisionCard";
import { RecordTable } from "../src/pages/agent/RecordTable";
const main = (sc = "normal") =>
  JSON.parse(readFileSync(`public/replay/${sc}.json`, "utf8")) as ReplayData;
afterEach(() => vi.unstubAllGlobals());
it("all 72 hours use exact exported selected/summary economics/reason; do not append a local baseline", () => {
  for (const sc of ["normal", "peak", "abstain"]) {
    const data = main(sc);
    for (let index = 0; index < 24; index++) {
      const agent = data.hours[index].agent,
        d = replayDecision(data, index);
      expect(d.reason).toBe(agent.explanation);
      expect(d.selected).toBe(agent.selected);
      expect(d.costWindowHours).toBe(agent.planning_horizon_hours);
      expect(d.candidates).toHaveLength(agent.candidate_summaries!.length);
      d.candidates.forEach((c, i) => {
        const s = agent.candidate_summaries![i];
        expect(c).toMatchObject({
          id: s.candidate_id,
          temp: s.hvac_setpoint_c,
          battery: s.battery_kw,
          cost: s.energy_cost_cny,
          peak: s.upper_grid_peak_kw,
          passed: s.constraint_valid,
        });
      });
    }
  }
});
it("absent summaries, selection, reason, receipt, ticket and actions remain missing even if load/weather changes", () => {
  const data = main(),
    a = data.hours[14].agent;
  delete a.candidate_summaries;
  delete a.selected;
  delete a.receipt;
  delete a.work_orders;
  delete (a as unknown as Record<string, unknown>).ticket_summary;
  delete a.selection_reason;
  a.explanation = "";
  const d = replayDecision(data, 14);
  expect(d.candidates).toEqual([]);
  expect(d.selected).toBe("暂无数据");
  expect(d.reason).toBe("暂无数据");
  expect(d.battery).toBeNull();
  expect(d.grounding).toBeNull();
  expect(d.receipt).toMatchObject({
    known: false,
    elapsed: null,
    transport: "暂无数据",
  });
  expect(d.ticket).toEqual({
    id: "暂无数据",
    reasons: ["暂无数据"],
    checks: ["暂无数据"],
    temp: null,
    battery: null,
  });
  data.hours[14].point_kw = 99999;
  data.hours[14].pv.power_kw = 99999;
  data.hours[14].storage.power_kw = 499;
  expect(replayDecision(data, 14)).toEqual(d);
  const html = renderToStaticMarkup(
    <DecisionCard
      data={data}
      index={14}
      decision={d}
      online={false}
      pending={false}
      onAction={() => {}}
    />,
  );
  expect(html).toContain('<td colSpan="5">暂无数据</td>');
  expect(html).not.toContain("YQ-");
  expect(html).not.toContain("核对天气");
  expect(html).not.toContain("核对通过");
  expect(n(null)).toBe("暂无数据");
  expect(storagePower(null)).toBe("暂无数据");
});
it("ticket summaries keep real checks/defaults without making up an ID", () => {
  const d = replayDecision(main("abstain"), 14);
  expect(d.ticket.id).toBe("暂无数据");
  expect(d.ticket.checks).toEqual([
    "核对表计与历史负荷",
    "核对天气及区间宽度",
    "确认人员与设备运行记录",
  ]);
  expect(d.ticket.temp).toBe(25.5);
  expect(d.ticket.battery).toBe(0);
});
it("schedule uses authoritative figures without presumed constraint evidence", () => {
  const data = main(),
    command = {
      timestamp: data.hours[14].t,
      hvac_setpoint_c: 25.5,
      battery_kw: 0,
    };
  const input = {
    building_id: data.meta.building_id,
    plan: [command],
    selected: "selected",
    reason: "接口理由原文",
    candidates: [
      {
        candidate_id: "selected",
        plan: [command],
        simulation: { estimated_cost: 123.4, estimated_peak_kw: 456.7 },
      },
    ],
  };
  const d = scheduleDecision(input, data, 14)!;
  expect(d.reason).toBe(input.reason);
  expect(d.candidates[0]).toMatchObject({
    cost: 123.4,
    peak: 456.7,
    passed: null,
  });
  expect(d.receipt.known).toBe(false);
  expect(
    scheduleDecision(
      { ...input, candidates: [{ ...input.candidates[0], passed: false }] },
      data,
      14,
    ),
  ).toBeNull();
  expect(
    scheduleDecision({ ...input, building_id: "different" }, data, 14),
  ).toBeNull();
});
it("midnight reads calendar-selected previous-day main 19-23 instead of current-day modulo", async () => {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      fetched.push(url);
      return new Response(
        readFileSync(`public/replay/${url.split("/").pop()!}`),
      );
    }),
  );
  const previous = await loadPreviousDay(
    new ReplayFileAdapter("/replay"),
    new Date(2026, 9, 12, 0).getTime(),
    "/replay",
  );
  expect(previous?.date).toBe("2026-10-11");
  expect(previous?.data.meta.scenario).toBe("abstain");
  const today = main(),
    rows = recentHours(today, 0, previous!.data);
  expect(rows.map((r) => r.index)).toEqual([19, 20, 21, 22, 23, 0]);
  expect(
    rows
      .slice(0, 5)
      .every(
        (r) => r.data === previous!.data && r.hour.t.startsWith("2017-07-04"),
      ),
  ).toBe(true);
  expect(fetched).toEqual([
    "/replay/ops-calendar.json",
    "/replay/abstain.json",
  ]);
  const html = renderToStaticMarkup(
    <RecordTable
      data={today}
      previous={previous!.data}
      index={0}
      current={replayDecision(today, 0)}
      statuses={{}}
    />,
  );
  expect(html).toContain("昨日 23:00");
  expect(html).toContain('data-record-scenario="abstain"');
});
it("unavailable calendar or previous date/source gives fewer real rows, not placeholders", async () => {
  const source = new ReplayFileAdapter("/replay");
  for (const response of [
    new Response("", { status: 404 }),
    new Response("{}"),
    new Response(readFileSync("public/replay/ops-calendar.json")),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response)
        .mockResolvedValue(
          new Response(readFileSync("public/replay/normal.json")),
        ),
    );
    expect(
      await loadPreviousDay(
        source,
        new Date(2026, 9, 12, 0).getTime(),
        "/replay",
      ),
    ).toBeNull();
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(readFileSync("public/replay/ops-calendar.json")),
    ),
  );
  expect(
    await loadPreviousDay(source, new Date(2026, 0, 1, 0).getTime(), "/replay"),
  ).toBeNull();
  const data = main();
  expect(recentHours(data, 0)).toHaveLength(1);
  expect(recentHours(data, 1)).toHaveLength(2);
  expect(recentHours(data, 4)).toHaveLength(5);
  expect(recentHours(data, 5)).toHaveLength(6);
  const html = renderToStaticMarkup(
    <RecordTable
      data={data}
      index={0}
      current={replayDecision(data, 0)}
      statuses={{}}
    />,
  );
  expect(html).not.toContain("昨日");
  expect(html).not.toContain("该时段记录未提供");
});

it("synced static zero receipts remain unexecuted; companion historical receipts never become current dispatch evidence", () => {
  for (const scenario of ["normal", "peak", "abstain"]) {
    const data = main(scenario),
      detail = JSON.parse(
        readFileSync(`public/replay/${scenario}.agent-detail.json`, "utf8"),
      );
    for (let index = 0; index < 24; index++) {
      const d = replayDecision(data, index);
      expect(d.receipt.known).toBe(false);
      expect(data.hours[index].agent.receipt?.count).toBe(0);
      const withDetail = structuredClone(data);
      withDetail.hours[index].agent = {
        ...data.hours[index].agent,
        ...detail.hours[String(index)].agent,
      };
      expect(replayDecision(withDetail, index).receipt.known).toBe(false);
    }
    const index = data.hours.findIndex((h) => !h.abstain),
      decision = replayDecision(data, index);
    const html = renderToStaticMarkup(
      <DecisionCard
        data={data}
        index={index}
        decision={decision}
        online={false}
        pending={false}
        onAction={() => {}}
      />,
    );
    expect(html).toContain("需要连接后端");
    expect(html).not.toContain("0 条指令");
    expect(html).not.toContain("回执暂无数据");
    expect(html).not.toContain("已自动下发 · 执行中");
  }
});

it("all battery presentation uses direction and absolute magnitude, keeping raw signed values", () => {
  for (const [v, label] of [
    [-365, "充电 365.0"],
    [120, "放电 120.0"],
    [0, "待机 0.0"],
    [-0.001, "待机 0.0"],
  ] as const) {
    expect(storageLabel(v)).toBe(label);
    expect(storagePower(v)).toBe(`${label} kW`);
  }
  const data = main(),
    current = replayDecision(data, 3),
    before = structuredClone(data);
  for (const connected of [true, false]) {
    const html = renderToStaticMarkup(
      <RecordTable
        data={data}
        index={3}
        current={current}
        statuses={{}}
        connected={connected}
      />,
    );
    expect(html).toContain(connected ? "暂无回执" : "需要连接后端");
    const rows = [
      ...html.matchAll(/<tr[^>]*data-record-t="[^"]+".*?<\/tr>/g),
    ].map((m) => m[0]);
    expect(rows).toHaveLength(4);
    for (const [index, row] of rows.entries()) {
      const d = replayDecision(data, 3 - index);
      expect(row).toContain(storagePower(d.battery));
      expect(row).not.toContain("人工工单");
      expect(row).not.toContain("999");
    }
  }
  expect(data).toEqual(before);
  const card = renderToStaticMarkup(
    <DecisionCard
      data={data}
      index={3}
      decision={{ ...current, selectionSource: undefined }}
      online={false}
      pending={false}
      onAction={() => {}}
    />,
  );
  expect(card).not.toContain("决策来源未提供");
});
