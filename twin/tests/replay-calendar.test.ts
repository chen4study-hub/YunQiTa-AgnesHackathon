import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { replayCalendar } from "../src/ui/replayCalendar";
import { formatDisplayDate } from "../src/config/presentation";
beforeEach(() => {vi.useFakeTimers();vi.setSystemTime(new Date(2026,9,12,14,0));});
afterEach(() => vi.useRealTimers());
it("maps raw wall-clock dates onto the public shell calendar without mutating source text", () => {
  const calendar = replayCalendar("normal", "2017-10-23T14:00:00-05:00");
  const raw =
    "2017-10-23T14:00:00-05:00 下发；2017-10-24 01:30 峰值；2017年10月22日 23:00 前日";
  expect(calendar.text(raw)).toBe(
    "2026-10-12 14:00 下发；2026-10-13 01:30 峰值；2026-10-11 23:00 前日",
  );
  expect(raw).toContain("2017-10-23T14:00:00-05:00");
  expect(calendar.text("YQ-20171023-14")).toBe("YQ-20261012-14");
  expect(
    calendar.text("2017 Jan-Dec8760; frozen2017monthly after2016bridge"),
  ).toBe("历史年度 Jan-Dec8760; frozen历史年度monthly after历史年度bridge");
  expect(calendar.text("2016.4 kW；+500.0 kW；90.5%")).toBe(
    "2016.4 kW；+500.0 kW；90.5%",
  );
});
it("compact dates have numeric boundaries but still work in presentation IDs", () => {
  const calendar = replayCalendar("abstain", "2017-07-04");
  expect(calendar.text("20170704 / YQ-20170704-14 / tag20170704end")).toBe(
    "20261012 / YQ-20261012-14 / tag20261012end",
  );
  for (const value of [
    "120170704",
    "201707041",
    "1201707041",
    "001201707040099",
    "201607040123456",
    "92016-07-04",
    "2017-07-041",
  ]) {
    expect(calendar.text(value), value).toBe(value);
  }
});
it("power, money, percentages and counts are measurements, not standalone years", () => {
  const calendar = replayCalendar("abstain", "2017-07-04");
  for (const year of ["2016", "2017"])
    for (const unit of ["kW", "kWh", "%", "元", "条", "小时"])
      for (const suffix of ["", "。", "；", "，", " ", "以内", "/小时"])
        for (const space of ["", " ", "\t"]) {
          const value = `${year}${space}${unit}${suffix}`;
          expect(calendar.text(value), value).toBe(value);
        }
  expect(
    calendar.text("2017年度，2016 年；费用2017元，功率2016kW，能量2017kWh"),
  ).toBe("历史年度年度，历史年度 年；费用2017元，功率2016kW，能量2017kWh");
  // Latin unit prefixes inside words must not mask historical-year labels.
  expect(calendar.text("2017 kWord; 2016 kWhExtra; 2017 Jan-Dec")).toBe(
    "历史年度 kWord; 历史年度 kWhExtra; 历史年度 Jan-Dec",
  );
});
it('explicit store date maps source text across local midnight regardless of route',()=>{
 const calendar=replayCalendar('abstain','2017-07-04T23:00:00-05:00',new Date(2026,9,12,23,59,59));
 expect(calendar.text('2017-07-05 01:30')).toBe('2026-10-13 01:30');
});
it("all routes use the same actual date and preserve midnight rollover", () => {
  for (const [scenario, origin] of [
    ["normal", "2017-10-23"],
    ["peak", "2017-07-20"],
    ["abstain", "2017-07-04"],
  ]) {
    const calendar = replayCalendar(scenario, `${origin}T23:00:00-05:00`);
    expect(calendar.text(origin)).toBe(
      formatDisplayDate(scenario as "normal" | "peak" | "abstain").slice(0, 10),
    );
    expect(calendar.text("2026-05-19 14:00；今天 14:00；次日 01:00")).toBe(
      "2026-05-19 14:00；今天 14:00；次日 01:00",
    );
  }
});
