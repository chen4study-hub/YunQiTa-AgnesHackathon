// Shared presentation contract for JSON and streaming chat.

const labels: Record<string, string> = {
  web_search: "联网查询",
  get_time: "查询时间",
  get_weather: "查询天气",
  current_energy: "查询当前能源",
  energy_summary: "能耗汇总",
  get_energy_summary: "能耗汇总",
  get_forecast: "负荷预测查询",
  get_context: "运行上下文查询",
  forecast_peak: "峰值计算",
  simulate_schedule: "调度方案计算",
  simulate_linear: "调度方案计算",
  compare_costs: "电费比较",
  check_constraints: "约束检查",
  explain_uncertainty: "不确定性分析",
};
export function toolLabel(tool: string, name?: string): string {
  return typeof name === "string" && name.trim()
    ? name
    : (labels[tool] ?? "运维数据查询");
}
export type ChatReason = "out_of_scope" | "no_data" | "answered";
export function chatReason(value: unknown): ChatReason | undefined {
  return value === "out_of_scope" || value === "no_data" || value === "answered"
    ? value
    : undefined;
}
export function answerCopy(
  _known: boolean,
  _needsHuman: boolean,
  answer: string,
  _tools: string[],
  _reason?: ChatReason,
): string {
  return answer;
}

/** Only process narration is reworded; backend answers remain untouched. */
export function processCopy(text: string): string {
  return text
    .replaceAll(
      "已读取指定当地日期范围内、起报后的逐步预测及门控。",
      "已读取所选日期后续的负荷预测与风险判断。",
    )
    .replaceAll("起报后的逐步预测", "后续负荷预测")
    .replaceAll("起报", "预测开始时刻");
}
