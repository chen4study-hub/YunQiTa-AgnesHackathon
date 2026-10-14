import {
  validateReplay,
  type ReplayData,
  type ScenarioInfo,
  type TwinDataSource,
  type ModelCard,
} from "../types";
import { validateModelCard, validateAgentDetail } from "../validate";
import type { AgentDetail, AgentDetailHour } from "../types";
const mainBytes = new WeakMap<ReplayData, ArrayBuffer>();
const detailCache = new WeakMap<ReplayData, Promise<AgentDetail>>();
async function getMain(url: string): Promise<ReplayData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`数据读取失败 ${response.status}`);
  const bytes = await response.arrayBuffer();
  const data = validateReplay(JSON.parse(new TextDecoder().decode(bytes)));
  mainBytes.set(data, bytes);
  return data;
}
async function loadDetail(
  data: ReplayData,
  hourIndex: number,
  base: string,
  api = false,
): Promise<AgentDetailHour> {
  const hour = data.hours[hourIndex];
  if (
    !hour ||
    !Number.isInteger(hour.agent.detail_index) ||
    data.schema_version !== "1.5" ||
    data.meta.agent_detail_file !== `${data.meta.scenario}.agent-detail.json` ||
    !/^(normal|peak|abstain)$/.test(data.meta.scenario)
  )
    throw new Error("Agent 明细索引不可用");
  let pending = detailCache.get(data);
  if (!pending) {
    pending = (async () => {
      let bytes = mainBytes.get(data);
      // API JSON is reserialized by the server. Verify against the synchronized
      // byte-exact main file, and refuse any divergent API snapshot.
      if (api) {
        const response = await fetch(`${base}/${data.meta.scenario}.json`);
        if (!response.ok) throw new Error("Agent 主文件不可用");
        bytes = await response.arrayBuffer();
        const snapshot = validateReplay(
          JSON.parse(new TextDecoder().decode(bytes)),
        );
        if (JSON.stringify(snapshot) !== JSON.stringify(data))
          throw new Error("API 与同步主文件不匹配");
      }
      if (!bytes) throw new Error("主文件原始字节不可用");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      return validateAgentDetail(
        await get(`${base}/${data.meta.agent_detail_file}`),
        data,
        sha,
      );
    })();
    detailCache.set(data, pending);
    void pending.catch(() => detailCache.delete(data));
  }
  const detail = await pending;
  return detail.hours[String(hour.agent.detail_index)];
}

export const scenarios: ScenarioInfo[] = [
  { id: "normal", title: "工作日" },
  { id: "peak", title: "高温日" },
  { id: "abstain", title: "节假日" },
];
const round = (value: number) => Math.round(value * 10) / 10;
function shiftTimestamp(t: string, hours: number) {
  const suffix = t.slice(-6);
  return (
    new Date(Date.parse(`${t.slice(0, 19)}Z`) + hours * 3600000)
      .toISOString()
      .slice(0, 19) + suffix
  );
}

export function mockReplay(id: string): ReplayData {
  if (!scenarios.some((scenario) => scenario.id === id))
    throw new Error("未知典型日");
  const date =
    id === "peak"
      ? "2017-07-20"
      : id === "abstain"
        ? "2017-04-09"
        : "2017-10-23";
  const hours = Array.from({ length: 24 }, (_, index) => {
    const point = round(
      800 +
        (id === "peak" ? 500 : id === "abstain" ? 320 : 450) *
          Math.exp(-(((index - 13) / 5) ** 2)),
    );
    const abstain = id === "abstain" && index >= 9 && index <= 16;
    const weights = Array.from({ length: 40 }, (_, floor) =>
      floor === 0 ? 0.7 : [13, 26].includes(floor) ? 0.4 : 1,
    );
    const total = weights.reduce((sum, value) => sum + value, 0);
    const floors = weights.map((weight) => round((point * weight) / total));
    floors[39] = round(
      point - floors.slice(0, 39).reduce((sum, value) => sum + value, 0),
    );
    const pv = round(130 * Math.max(0, Math.sin(((index - 6) / 12) * Math.PI)));
    const storage = abstain
      ? 0
      : index >= 12 && index <= 16
        ? 150
        : index < 5
          ? -80
          : 0;
    return {
      t: `${date}T${String(index).padStart(2, "0")}:00:00-06:00`,
      actual_kw: round(
        Math.max(800, Math.min(1300, point + Math.sin(index * 1.7) * 12)),
      ),
      point_kw: point,
      lower_kw: round(point - (abstain ? 160 : 25)),
      upper_kw: round(point + (abstain ? 160 : 25)),
      confidence: abstain ? 0.65 : 0.93,
      risk_score: abstain ? 0.92 : 0.25,
      risk_threshold: 0.84,
      abstain,
      abstain_reason: abstain ? "预测风险超过阈值" : null,
      outdoor_temp_c: round(
        21 + 9 * Math.max(0, Math.sin(((index - 6) / 12) * Math.PI)),
      ),
      floors_kw: floors,
      storage: {
        power_kw: storage,
        soc: Math.max(0.2, Math.min(0.9, 0.6 - Math.max(0, index - 12) * 0.03)),
      },
      pv: { power_kw: pv },
      grid_kw: round(point - pv - storage),
      agent: {
        status: abstain ? ("handoff" as const) : ("executed" as const),
        source: "mock" as const,
        hvac_setpoint_c: 25,
        actions: abstain ? [] : ["维持 25 °C 设定值"],
        explanation: abstain
          ? "预测风险偏高，转交人工复核。"
          : "置信评分通过门控，维持当前设备设定。",
      },
    };
  });
  // Contract-complete deterministic fixtures, separate from measured file exports.
  const completeHours = hours.map((hour, index) => ({
    ...hour,
    recent_actual: [-1, 0].map((offset) => ({
      t: shiftTimestamp(hour.t, offset),
      actual_kw: hours[(index + offset + 24) % 24].actual_kw,
    })),
    forecast_24h: Array.from({ length: 24 }, (_, i) => {
      const profile = hours[(index + i + 1) % 24];
      return {
        t: shiftTimestamp(hour.t, i + 1),
        horizon: i + 1,
        point_kw: profile.point_kw,
        lower_kw: profile.lower_kw,
        upper_kw: profile.upper_kw,
        confidence: profile.confidence,
        abstain: profile.abstain,
        risk_score: profile.risk_score,
        risk_threshold: profile.risk_threshold,
        confidence_threshold: 0.887,
        floors_kw: [...profile.floors_kw],
      };
    }),
  }));
  return validateReplay({
    schema_version: "1.2",
    meta: {
      scenario: id,
      title: scenarios.find((scenario) => scenario.id === id)!.title,
      date,
      building_id: "Hog_office_Byron",
      display_name: "云栖塔",
      sqm: 80038.2,
      floors: 40,
      floors_source: "estimated_from_area",
      floor_uses: Array.from({ length: 40 }, (_, index) =>
        index === 0 ? "lobby" : [13, 26].includes(index) ? "garden" : "office",
      ),
      alpha: 0.095,
      model_version: "mock-contract-1.2",
      multi_horizon_model_version: "mock-24h-1.2",
      forecast_weather: "persistence_at_origin",
      operating_point: "mock",
      mode: "auto",
      confidence_threshold: 0.887,
      data_source: {
        name: "Building Data Genome 2 (BDG2)",
        attribution: "Miller et al., 2020",
        url: "https://github.com/buds-lab/building-data-genome-project-2",
        license: "CC BY-SA 4.0",
        modifications:
          "Deterministic frontend fixture; not measured BDG2 readings.",
      },
      units: { power: "kW", temperature: "°C" },
      simulated_fields: [
        "storage",
        "pv",
        "grid_kw",
        "point_kw",
        "actual_kw",
        "campus",
      ],
      estimated_fields: ["floors_kw"],
    },
    hours: completeHours,
    campus: [],
  });
}

export class MockAdapter implements TwinDataSource {
  async listScenarios() {
    return scenarios;
  }
  async loadScenario(id: string) {
    return mockReplay(id);
  }
  async loadModelCard(): Promise<ModelCard> {
    return {
      model_version: "mock-contract-1.2",
      retained_coverage: null,
      target_coverage: 0.905,
      cross_building_coverage: null,
      rejection_rate: null,
      retained_mae: null,
    };
  }
}

async function get(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`数据读取失败 ${response.status}`);
  return response.json();
}
function indexRows(input: unknown): ScenarioInfo[] {
  if (!Array.isArray(input)) throw new Error("典型日索引无效");
  return input.map((row) => {
    if (!row || typeof row !== "object") throw new Error("典型日索引条目无效");
    const value = row as Record<string, unknown>;
    const id = value.id ?? value.scenario;
    if (typeof id !== "string" || typeof value.title !== "string")
      throw new Error("典型日索引字段缺失");
    return { id, title: value.title };
  });
}
export class ReplayFileAdapter implements TwinDataSource {
  constructor(private base = `${import.meta.env.BASE_URL}replay`) {}
  async listScenarios() {
    return indexRows(await get(`${this.base}/index.json`));
  }
  async loadScenario(id: string) {
    return getMain(`${this.base}/${encodeURIComponent(id)}.json`);
  }
  async loadModelCard() {
    return validateModelCard(await get(`${this.base}/model_card.json`));
  }
  loadAgentDetail(data: ReplayData, hourIndex: number) {
    return loadDetail(data, hourIndex, this.base);
  }
}
export class ApiAdapter implements TwinDataSource {
  constructor(
    private base = "/api",
    private detailBase = `${import.meta.env.BASE_URL}replay`,
  ) {}
  loadAgentDetail(data: ReplayData, hourIndex: number) {
    return loadDetail(data, hourIndex, this.detailBase, true);
  }
  async listScenarios() {
    return indexRows(await get(`${this.base}/replay`));
  }
  async loadScenario(id: string) {
    return getMain(`${this.base}/replay/${encodeURIComponent(id)}`);
  }
  async loadModelCard() {
    return validateModelCard(
      await get(`${import.meta.env.BASE_URL}replay/model_card.json`),
    );
  }
}
