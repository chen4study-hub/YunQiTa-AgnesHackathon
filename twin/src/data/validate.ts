import {
  validateReplay as replaySchemaValidator,
  validateAgentDetail as detailValidator,
  validationErrorsText,
} from "./validators";
import type { ReplayData, ModelCard, AgentDetail } from "./types";

export function validateReplay(input: unknown): ReplayData {
  const version =
    input && typeof input === "object"
      ? (input as { schema_version?: string }).schema_version
      : undefined;
  const validate = replaySchemaValidator(
    typeof version === "string" ? version : "",
  );
  if (!validate(input))
    throw new Error(`预测契约不匹配: ${validationErrorsText(validate.errors)}`);
  const data = input as ReplayData;
  data.hours.forEach((hour, index) => {
    if (
      Number(hour.t.slice(11, 13)) !== index ||
      hour.lower_kw > hour.point_kw ||
      hour.point_kw > hour.upper_kw ||
      Math.abs(
        hour.floors_kw.reduce((sum, value) => sum + value, 0) - hour.point_kw,
      ) > 0.11 ||
      (hour.abstain && hour.agent.status !== "handoff")
    ) {
      throw new Error(`小时数据不一致: ${index}`);
    }
    const origin = Date.parse(hour.t);
    hour.forecast_24h.forEach((point, i) => {
      if (
        point.horizon !== i + 1 ||
        Date.parse(point.t) !== origin + (i + 1) * 3600000 ||
        point.lower_kw > point.point_kw ||
        point.point_kw > point.upper_kw ||
        Math.abs(
          point.floors_kw.reduce((sum, value) => sum + value, 0) -
            point.point_kw,
        ) > 0.11
      ) {
        throw new Error(`预测窗口不一致: ${index}/${i + 1}`);
      }
    });
    hour.recent_actual.forEach((point, i) => {
      if (Date.parse(point.t) !== origin + (i - 1) * 3600000)
        throw new Error(`实测窗口不一致: ${index}`);
    });
  });
  return data;
}

/** Hash is checked against the exact fetched main bytes, not reserialized JSON. */
export function validateAgentDetail(
  input: unknown,
  main: ReplayData,
  mainSha256: string,
): AgentDetail {
  if (!detailValidator(input))
    throw new Error(
      `Agent 明细契约不匹配: ${validationErrorsText(detailValidator.errors)}`,
    );
  const detail = input as AgentDetail;
  if (
    detail.main_sha256 !== mainSha256 ||
    detail.scenario !== main.meta.scenario ||
    detail.building_id !== main.meta.building_id
  )
    throw new Error("Agent 明细与主文件不匹配");
  for (const hour of main.hours) {
    const index = hour.agent.detail_index;
    const row = index === undefined ? undefined : detail.hours[String(index)];
    if (
      !row ||
      row.t !== hour.t ||
      row.agent.status !== hour.agent.status ||
      row.agent.selected !== hour.agent.selected ||
      row.agent.explanation !== hour.agent.explanation
    )
      throw new Error("Agent 明细小时索引不匹配");
  }
  return detail;
}

export function validateModelCard(input: unknown): ModelCard {
  if (!input || typeof input !== "object") throw new Error("模型结果文件无效");
  const card = input as ModelCard;
  if (
    typeof card.model_version !== "string" ||
    !Number.isFinite(card.target_coverage)
  )
    throw new Error("模型结果字段缺失");
  for (const key of [
    "retained_coverage",
    "cross_building_coverage",
    "rejection_rate",
    "retained_mae",
  ] as const) {
    if (card[key] !== null && !Number.isFinite(card[key]))
      throw new Error(`模型结果无效: ${key}`);
  }
  return card;
}
