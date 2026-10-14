import { afterEach, it, expect, vi } from "vitest";
import {
  takeoverRequest,
  readRecommendation,
  buildTakeoverInput,
  prefillTakeoverFields,
  readTakeover,
  takeoverCovers,
  takeoverIsActive,
  readServiceReceipt,
  controlSummary,
  takeoverInterval,
  rememberedOperator,
  rememberOperator,
  recordEventTime,
  sortTakeoverHistory,
  sortReceiptCommands,
  latestHourCancellation,
  readHourCancellation,
} from "../src/pages/agent/takeover-api";
const rec = {
  api_version: "1.0",
  available: true,
  request_id: "server",
  hvac_setpoint_c: 25.6,
  storage_mode: "idle" as const,
  storage_power_kw: 0,
  duration_hours: 3,
  reason: "推荐理由原文",
  recommendation_hash: "hash",
};
const fields = {
  duration: "",
  temp: "",
  mode: "" as const,
  power: "",
  reason: "",
  operator: "值班甲",
};
afterEach(() => vi.unstubAllGlobals());
it("untouched controls use recommendation and hash; idle is exactly zero; display day stays separate from source day", () => {
  const body = buildTakeoverInput(
    "2026-10-12",
    14,
    fields,
    readRecommendation(rec),
    "request-1",
  );
  expect(body).toEqual({
    date: "2026-10-12",
    hour: 14,
    duration_hours: 3,
    hvac_setpoint_c: 25.6,
    storage_mode: "idle",
    storage_power_kw: 0,
    reason: "推荐理由原文",
    operator_id: "值班甲",
    request_id: "request-1",
    recommendation_hash: "hash",
  });
  expect(
    buildTakeoverInput(
      "2026-10-12",
      22,
      { ...fields, mode: "charge", power: "40", temp: "26", duration: "24" },
      rec,
      "request-2",
    ),
  ).toMatchObject({
    storage_power_kw: 40,
    storage_mode: "charge",
    hvac_setpoint_c: 26,
    duration_hours: 24,
  });
  expect(() =>
    buildTakeoverInput(
      "2026-10-12",
      14,
      { ...fields, mode: "charge" },
      rec,
      "request-3",
    ),
  ).toThrow();
});
it("unavailable recommendation has no numeric fallback; only explicit valid complete controls can submit", () => {
  const missing = { available: false, message: "该小时无推荐" };
  expect(() =>
    buildTakeoverInput("2026-10-12", 2, fields, missing, "id"),
  ).toThrow();
  expect(
    buildTakeoverInput(
      "2026-10-12",
      2,
      {
        ...fields,
        temp: "24",
        duration: "1",
        mode: "idle",
        reason: "人工核对",
      },
      missing,
      "id",
    ),
  ).toMatchObject({
    hvac_setpoint_c: 24,
    storage_power_kw: 0,
    reason: "人工核对",
  });
  for (const patch of [
    { duration: "25" },
    { duration: "1.5" },
    { temp: "0" },
    { temp: "28" },
    { power: "501", mode: "discharge" as const },
    { operator: "" },
  ])
    expect(() =>
      buildTakeoverInput("2026-10-12", 2, { ...fields, ...patch }, rec, "id"),
    ).toThrow();
});
it("requires versioned JSON, rejects HTML fallback and missing versions; writes once without replay", async () => {
  for (const response of [
    new Response("<html/>", { headers: { "content-type": "text/html" } }),
    new Response("{}", { headers: { "content-type": "application/json" } }),
    new Response("null", { headers: { "content-type": "application/json" } }),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(takeoverRequest("/takeover", {})).rejects.toMatchObject({
      message: "接管服务暂不可用，请稍后重试",
      disconnected: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rec), {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  await expect(
    takeoverRequest("/takeover/recommendation?date=2026-10-12&hour=14"),
  ).resolves.toMatchObject({ api_version: "1.0" });
  expect(fetch).toHaveBeenCalledWith(
    "/api/takeover/recommendation?date=2026-10-12&hour=14",
    expect.objectContaining({ method: "GET", cache: "no-store" }),
  );
});
it("preserves backend detail exactly, including errors without api_version", async () => {
  for (const status of [409, 422, 503]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "推荐已更新，请重新确认" }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(takeoverRequest("/takeover", {})).rejects.toMatchObject({
      message: "推荐已更新，请重新确认",
      disconnected: false,
    });
  }
  expect(() => readRecommendation({ available: true })).toThrow(
    "接管服务暂不可用，请稍后重试",
  );
  expect(() => readTakeover({ id: "bad" })).toThrow();
  expect(readTakeover(null)).toBeNull();
});

it("only active records cover a decision: later cancellation and expiry never override exports", () => {
  const at = Date.parse("2026-10-12T02:00:00+08:00"),
    r = {
      id: "x",
      version: 1,
      start_ms: at,
      end_ms: at + 2 * 3600000,
      status: "active",
      cancelled_ms: null,
    } as any;
  expect(takeoverCovers(r, "2026-10-12", 2)).toBe(true);
  expect(takeoverCovers(r, "2026-10-12", 4)).toBe(false);
  for (const record_status of ["expired", "cancelled"])
    expect(
      takeoverCovers(
        { ...r, status: "manual", record_status, cancelled_ms: at + 3600000 },
        "2026-10-12",
        2,
      ),
    ).toBe(false);
  expect(
    takeoverCovers({ ...r, cancelled_ms: at + 3600000 }, "2026-10-12", 2),
  ).toBe(false);
});
it("receipt renderer whitelists BA/EMS/actions and preserves effectiveness without provenance", () => {
  const r = readServiceReceipt({
    source: "manual",
    source_key: "secret",
    export_sha256: "secret",
    records: [
      {
        destination: "BA",
        command: { setpoint_c: 26.2, source_key: "secret" },
        effective: false,
      },
      { destination: "EMS", command: { battery_kw: -40 }, effective: true },
    ],
    receipt: { count: 2, elapsed_ms: 0 },
  });
  expect(r.records).toEqual([
    {
      destination: "EMS",
      command: { battery_kw: -40 },
      effective: true,
      source: undefined,
      created_at: undefined,
    },
    {
      destination: "BA",
      command: { setpoint_c: 26.2 },
      effective: false,
      source: undefined,
      created_at: undefined,
    },
  ]);
  expect(JSON.stringify(r)).not.toContain("secret");
  expect(
    readServiceReceipt({ source: "agent", actions: ["BA 已写入", {}] }).actions,
  ).toEqual(["BA 已写入"]);
  expect(() => readServiceReceipt({ source: "unknown" })).toThrow();
  expect(
    controlSummary({
      hvac_setpoint_c: 26,
      storage_mode: "idle",
      storage_power_kw: 0,
      reason: "核对完成",
      source_key: "secret",
      export_sha256: "secret",
    }),
  ).toBe("温控 26.0 °C · 储能 待机 · 核对完成");
});

it("compact intervals use display date and next-day labels, never expose ISO offsets", () => {
  expect(
    takeoverInterval(
      "2026-10-13T14:00:00+08:00",
      "2026-10-13T15:00:00+08:00",
      "2026-10-13",
    ),
  ).toBe("14:00–15:00");
  expect(
    takeoverInterval(
      "2026-10-13T23:00:00+08:00",
      "2026-10-14T01:00:00+08:00",
      "2026-10-13",
    ),
  ).toBe("23:00–次日 01:00");
});
it("operator remembers only within sessionStorage and disabled storage remains safe", () => {
  let value = "";
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: () => value,
      setItem: (_: string, v: string) => {
        value = v;
      },
    },
  });
  rememberOperator("值班丁");
  expect(rememberedOperator()).toBe("值班丁");
  vi.stubGlobal("window", {
    get sessionStorage() {
      throw new Error("disabled");
    },
  });
  expect(rememberedOperator()).toBe("");
  expect(() => rememberOperator("甲")).not.toThrow();
});

it("write/event times convert UTC to Shanghai with compact cross-day labels, never manufacture unknown times", () => {
  expect(recordEventTime("2026-10-12T06:02:00+00:00", "2026-10-12")).toBe(
    "14:02",
  );
  expect(recordEventTime("2026-10-12T16:02:00Z", "2026-10-12")).toBe(
    "次日 00:02",
  );
  expect(recordEventTime(undefined, "2026-10-12")).toBe("时间暂无数据");
  expect(recordEventTime("invalid", "2026-10-12")).toBe("时间暂无数据");
});
it("effective commands lead, inactive commands follow; latest creation first without sorting by control hour", () => {
  const rows = [
    {
      destination: "BA",
      command: { setpoint_c: 26 },
      effective: false,
      created_at: "2026-10-12T06:03:00Z",
    },
    {
      destination: "EMS",
      command: { battery_kw: 0 },
      effective: true,
      created_at: "2026-10-12T06:01:00Z",
    },
    {
      destination: "BA",
      command: { setpoint_c: 25 },
      effective: true,
      created_at: "2026-10-12T06:02:00Z",
    },
  ];
  expect(sortReceiptCommands(rows).map((r) => r.command)).toEqual([
    { setpoint_c: 25 },
    { battery_kw: 0 },
    { setpoint_c: 26 },
  ]);
  expect(rows[0].effective).toBe(false);
  const histories = [
    { id: "old", created_at: "2026-10-12T06:00:00Z" },
    { id: "new", created_at: "2026-10-12T06:05:00Z" },
    { id: "unknown" },
  ] as any;
  expect(sortTakeoverHistory(histories).map((r) => r.id)).toEqual([
    "new",
    "old",
    "unknown",
  ]);
});

it("cancellation notice is the latest persisted cancellation covering this hour, with cancelling actor not creating actor", () => {
  const row = {
    id: "old",
    start_at: "2026-10-12T14:00:00+08:00",
    end_at: "2026-10-12T15:00:00+08:00",
    cancelled_at: "2026-10-12T06:58:00Z",
    operator_id: "创建甲",
    cancelled_by: "撤销乙",
  };
  expect(latestHourCancellation([row], "2026-10-12", 14)).toEqual({
    id: "old",
    cancelled_at: row.cancelled_at,
    operator_id: "撤销乙",
  });
  expect(latestHourCancellation([row], "2026-10-12", 15)).toBeNull();
  expect(latestHourCancellation([row], "2026-10-13", 14)).toBeNull();
  expect(
    latestHourCancellation(
      [{ ...row, id: "new", cancelled_at: "2026-10-12T06:59:00Z" }, row],
      "2026-10-12",
      14,
    )?.id,
  ).toBe("new");
  expect(
    latestHourCancellation(
      [{ ...row, cancelled_at: null }, null, {}],
      "2026-10-12",
      14,
    ),
  ).toBeNull();
});

it("history cancellation loader follows server pagination instead of missing later records", async () => {
  const row = {
    id: "page2",
    start_at: "2026-10-12T14:00:00+08:00",
    end_at: "2026-10-12T15:00:00+08:00",
    cancelled_at: "2026-10-12T06:58:00Z",
    cancelled_by: "撤销乙",
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          api_version: "1.0",
          timezone: "Asia/Shanghai",
          items: Array(200).fill({}),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          api_version: "1.0",
          timezone: "Asia/Shanghai",
          items: [row],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  expect((await readHourCancellation("2026-10-12", 14))?.id).toBe("page2");
  expect(fetcher.mock.calls[1][0]).toContain("offset=200");
});

it("current active display must honor record_status, even for a historically covered manual alias", () => {
  const record = {
    start_ms: Date.parse("2026-10-12T14:00:00+08:00"),
    end_ms: Date.parse("2026-10-12T15:00:00+08:00"),
    status: "manual",
  } as any;
  expect(
    takeoverIsActive({ ...record, record_status: "active" }, "2026-10-12", 14),
  ).toBe(true);
  for (const record_status of ["cancelled", "expired", "unknown"])
    expect(
      takeoverIsActive({ ...record, record_status }, "2026-10-12", 14),
    ).toBe(false);
  expect(
    takeoverIsActive({ ...record, status: "active" }, "2026-10-12", 14),
  ).toBe(true);
});

it("recommendations prefill four untouched controls without rounding or overwriting cleared/edited values", () => {
  const r = {
    ...rec,
    storage_mode: "charge" as const,
    storage_power_kw: 199.9999000175467,
  };
  const filled = prefillTakeoverFields(fields, r);
  expect(filled).toMatchObject({
    duration: "3",
    temp: "25.6",
    mode: "charge",
    power: "199.9999000175467",
    reason: "",
    operator: "值班甲",
  });
  expect(
    buildTakeoverInput("2026-10-13", 14, filled, r, "id").storage_power_kw,
  ).toBe(r.storage_power_kw);
  const edited = {
    ...filled,
    temp: "",
    duration: "1",
    power: "40",
    mode: "" as const,
  };
  expect(
    prefillTakeoverFields(edited, r, {
      temp: true,
      duration: true,
      power: true,
      mode: true,
    }),
  ).toEqual(edited);
  expect(prefillTakeoverFields(fields, { available: false })).toBe(fields);
  expect(fields.temp).toBe("");
});
