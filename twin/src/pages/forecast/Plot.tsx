import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { chartTypography } from "./typography";
import { darkTheme } from "../../ui/chartTheme";

// Local theme only: do not alter the overview/public theme.
export function forecastTheme(host?: Element) {
  const fonts = chartTypography(host);
  return {
    ...darkTheme,
    textStyle: {
      ...darkTheme.textStyle,
      fontSize: fonts.label,
      fontFamily: '"Microsoft YaHei", system-ui, sans-serif',
    },
    categoryAxis: {
      ...darkTheme.categoryAxis,
      axisLabel: { ...darkTheme.categoryAxis.axisLabel, fontSize: fonts.label },
      nameTextStyle: { fontSize: fonts.label },
    },
    valueAxis: {
      ...darkTheme.valueAxis,
      axisLabel: { ...darkTheme.valueAxis.axisLabel, fontSize: fonts.label },
      nameTextStyle: { fontSize: fonts.label },
    },
    timeAxis: {
      axisLabel: { fontSize: fonts.label },
      nameTextStyle: { fontSize: fonts.label },
    },
    logAxis: {
      axisLabel: { fontSize: fonts.label },
      nameTextStyle: { fontSize: fonts.label },
    },
    axisPointer: { label: { fontSize: fonts.label } },
    markLine: {
      label: { fontSize: fonts.label },
      emphasis: { label: { fontSize: fonts.label } },
    },
    markPoint: {
      label: { fontSize: fonts.label },
      emphasis: { label: { fontSize: fonts.label } },
    },
    markArea: {
      label: { fontSize: fonts.label },
      emphasis: { label: { fontSize: fonts.label } },
    },
    legend: {
      ...darkTheme.legend,
      textStyle: { ...darkTheme.legend.textStyle, fontSize: fonts.legend },
    },
    tooltip: {
      ...darkTheme.tooltip,
      textStyle: { ...darkTheme.tooltip.textStyle, fontSize: fonts.body },
    },
  };
}
export function Plot({
  option,
  label,
  className = "",
  replaceMerge,
  onReady,
}: {
  option: echarts.EChartsOption;
  label: string;
  className?: string;
  replaceMerge?: string[];
  onReady?: (instance: echarts.ECharts | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    if (!host.current) return;
    const instance = echarts.init(host.current, forecastTheme(host.current));
    chart.current = instance;
    const observer = new ResizeObserver(() => {
      instance.resize();
      ready.current?.(instance);
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      ready.current?.(null);
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    chart.current?.setOption(option, {
      notMerge: false,
      lazyUpdate: !ready.current,
      replaceMerge,
    });
    ready.current?.(chart.current);
  }, [option, replaceMerge]);
  return (
    <div
      ref={host}
      className={`forecast-plot ${className}`}
      role="img"
      aria-label={label}
    />
  );
}
