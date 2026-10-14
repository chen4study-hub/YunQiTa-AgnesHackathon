import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { seriesTooltip } from "../energy/tooltips";
import { floorsNumber } from "./numbers";
import { formatNumber } from "../../ui/numberFormat";
import {
  floorColor,
  FLOOR_COLORS,
  EQUIPMENT_COLOR,
  type FloorColorScale,
} from "../../ui/floorColors";
import {
  INCREMENTAL_UPDATE,
  smoothOption,
  mobileReadableOption,
  readChartTypography,
  installRichTooltipTypography,
  registerEnergySmoothTheme,
} from "../energy/SmoothChart";

export function FloorLoadLegend({ scale }: { scale: FloorColorScale }) {
  return (
    <div
      className="floors-load-legend"
      aria-label="办公层8–20点分位数色标，设备层独立显示"
    >
      {["低", "中", "高"].map((label, index) => (
        <span
          key={label}
          title={`办公层8–20点 p${[10, 50, 90][index]} · ${formatNumber([scale.p10, scale.p50, scale.p90][index], 1)} kW`}
        >
          <i style={{ background: FLOOR_COLORS[index] }} />
          {label} {formatNumber([scale.p10, scale.p50, scale.p90][index], 1)} kW
          <span className="floors-legend-percentile">
            {" "}
            · p{[10, 50, 90][index]}
          </span>
        </span>
      ))}
      <span>
        <i style={{ background: EQUIPMENT_COLOR }} />
        设备层
      </span>
    </div>
  );
}
export function floorLabelStride(
  count: number,
  height: number,
  labelSize: number,
) {
  return Math.max(
    1,
    Math.ceil((count * (labelSize + 2)) / Math.max(1, height - 46)),
  );
}
export function floorLoadOption(
  loads: number[],
  selected: number,
  height = 760,
  scale: FloorColorScale,
  floorUses: readonly string[] = [],
  labelSize = 12,
): EChartsOption {
  const stride = floorLabelStride(loads.length, height, labelSize);
  const axisStep = Math.max(10, Math.ceil(Math.max(0, ...loads) / 60) * 10);
  const visible = (index: number) => {
    if (index === selected - 1) return true;
    if (Math.abs(index - (selected - 1)) < stride) return false;
    if (index === 0 || index === loads.length - 1) return true;
    return (
      (index + 1) % stride === 0 &&
      index >= stride &&
      index < loads.length - stride
    );
  };
  return {
    animation: false,
    grid: { top: 12, bottom: 34, left: 42, right: 58 },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      formatter: (params) => seriesTooltip(params, { default: "kW" }, false),
    },
    xAxis: {
      type: "value",
      name: "kW",
      nameGap: 10,
      min: 0,
      max: Math.ceil(Math.max(axisStep, ...loads) / axisStep) * axisStep,
      interval: axisStep,
      axisLabel: {
        color: "#8597a3",
        formatter: (value: number) => floorsNumber(value),
      },
      splitLine: { lineStyle: { color: "#1c2a36" } },
    },
    yAxis: {
      type: "category",
      data: loads.map((_, i) => `${i + 1}F`),
      axisLabel: { interval: visible, color: "#a8bac7", fontSize: labelSize },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        barWidth: "64%",
        label: {
          show: true,
          position: "right",
          color: "#a8bac7",
          fontSize: labelSize,
          formatter: (p) => formatNumber(Number(p.value), 1),
        },
        data: loads.map((value, index) => ({
          value,
          label: { show: visible(index) },
          itemStyle: {
            color: floorColor(value, scale, floorUses[index]),
            borderColor: index + 1 === selected ? "#4fd1d9" : "transparent",
            borderWidth: index + 1 === selected ? 2 : 0,
          },
        })),
      },
    ],
  };
}
export function FloorLoadChart({
  loads,
  selected,
  onSelect,
  scale,
  floorUses,
}: {
  loads: number[];
  selected: number;
  onSelect: (floor: number) => void;
  scale: FloorColorScale;
  floorUses: readonly string[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const latest = useRef({ loads, selected, scale, floorUses });
  latest.current = { loads, selected, scale, floorUses };
  const update = () => {
    if (!chart.current || !host.current) return;
    const typography = readChartTypography(host.current);
    chart.current.setOption(
      smoothOption(
        mobileReadableOption(
          floorLoadOption(
            latest.current.loads,
            latest.current.selected,
            host.current.clientHeight,
            latest.current.scale,
            latest.current.floorUses,
            typography.label,
          ),
          window.matchMedia("(max-width: 640px)").matches,
          typography,
        ),
      ),
      INCREMENTAL_UPDATE,
    );
    host.current.dataset.colorScale = JSON.stringify(latest.current.scale);
    host.current.dataset.barCount = String(latest.current.loads.length);
    host.current.dataset.labelStride = String(
      floorLabelStride(
        latest.current.loads.length,
        host.current.clientHeight,
        typography.label,
      ),
    );
  };
  useEffect(() => {
    if (!host.current) return;
    registerEnergySmoothTheme(host.current);
    const instance = echarts.init(host.current, "energy-smooth");
    chart.current = instance;
    const removeTooltipTypography = installRichTooltipTypography(instance);
    host.current.dataset.chartId = instance.id;
    instance.on("click", (event) => {
      if (event.componentType === "series") select.current(event.dataIndex + 1);
    });
    const observer = new ResizeObserver(() => {
      instance.resize();
      update();
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      removeTooltipTypography();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    update();
  }, [loads, selected, scale, floorUses]);
  return (
    <div
      ref={host}
      className="floors-load-chart"
      role="img"
      aria-label="40层楼层负荷横向柱图，点击柱条选择楼层"
      aria-description="绿、黄、橙分别对应办公层8–20点负荷的第10、第50、第90百分位；设备层独立显示为灰色。"
    />
  );
}
