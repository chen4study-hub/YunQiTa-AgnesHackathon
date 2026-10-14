import type { EChartsOption, ECharts } from "echarts";
import { tooltipDefaults } from "./chartTooltip";

/** Stable instance, normal merge, stable series IDs; never clear or rebuild. */
export const chartMerge = { notMerge: false, lazyUpdate: true } as const;
export function chartPresentation(
  option: EChartsOption,
  reducedMotion: boolean,
): EChartsOption {
  return {
    ...tooltipDefaults(option),
    ...(reducedMotion ? { animation: false } : {}),
  };
}
export function updateChart(
  instance: ECharts,
  option: EChartsOption,
  reducedMotion: boolean,
) {
  instance.setOption(chartPresentation(option, reducedMotion), chartMerge);
}
