import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { darkTheme } from "../../ui/chartTheme";

export const energySmoothTheme = { ...darkTheme };
export type ChartTypography = {
  label: number;
  legend: number;
  tooltip: number;
};
/** Resolve clamp()/rem expressions in CSS pixels, rather than parseFloat on tokens. */
export function readChartTypography(host: HTMLElement): ChartTypography {
  const probe = document.createElement("span");
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none";
  host.append(probe);
  const read = (token: string) => {
    probe.style.fontSize = `var(${token})`;
    return parseFloat(getComputedStyle(probe).fontSize);
  };
  const label = Math.max(12, read("--font-label"));
  const legend = Math.max(12, read("--font-legend"));
  probe.remove();
  return { label, legend, tooltip: Math.max(13, label + 1) };
}
export function registerEnergySmoothTheme(host: HTMLElement) {
  const sizes = readChartTypography(host);
  echarts.registerTheme("energy-smooth", {
    ...energySmoothTheme,
    textStyle: { ...energySmoothTheme.textStyle, fontSize: sizes.label },
    legend: {
      ...energySmoothTheme.legend,
      textStyle: {
        ...energySmoothTheme.legend.textStyle,
        fontSize: sizes.legend,
      },
    },
    tooltip: {
      ...energySmoothTheme.tooltip,
      textStyle: {
        ...energySmoothTheme.tooltip.textStyle,
        fontSize: sizes.tooltip,
      },
    },
  });
}
echarts.registerTheme("energy-smooth", energySmoothTheme);
/** ECharts 5.6's rich tooltip omits textStyle.fontSize for custom plain-string
 * formatters. Apply it to the tooltip Text root on showTip, before canvas paint.
 * Uses public ZRender roots/Text.setStyle only; never patches shared prototypes. */
export function installRichTooltipTypography(instance: echarts.ECharts) {
  const apply = () => {
    const option = instance.getOption();
    const tooltip = (
      option.tooltip as { z?: number; textStyle?: { fontSize?: number } }[]
    )?.[0];
    for (const root of instance.getZr().storage.getRoots()) {
      if (
        root instanceof echarts.graphic.Text &&
        root.z === (tooltip?.z ?? 60)
      ) {
        root.setStyle({
          fontSize:
            tooltip?.textStyle?.fontSize ??
            energySmoothTheme.tooltip.textStyle.fontSize,
        });
      }
    }
  };
  instance.on("showTip", apply);
  return () => instance.off("showTip", apply);
}
export const INCREMENTAL_UPDATE = {
  notMerge: false,
  lazyUpdate: true,
} as const;
export function smoothOption(option: EChartsOption): EChartsOption {
  const series = Array.isArray(option.series)
    ? option.series
    : option.series
      ? [option.series]
      : [];
  return {
    ...option,
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 360,
    animationEasingUpdate: "cubicOut",
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      ...option.tooltip,
      textStyle: {
        ...energySmoothTheme.tooltip.textStyle,
        ...(option.tooltip as { textStyle?: object })?.textStyle,
      },
    },
    series: series.map((item, index) => ({
      ...item,
      id: item.id ?? item.name ?? `series-${index}`,
    })),
  };
}
/** Canvas text cannot inherit CSS. Apply the host's shared note token while
 * preserving callbacks, data, series identities and the 12px plot / 13px tooltip floors. */
export function mobileReadableOption(
  option: EChartsOption,
  mobile: boolean,
  typography?: number | ChartTypography,
): EChartsOption {
  const sizes =
    typeof typography === "object"
      ? typography
      : {
          label: Math.max(
            12,
            typography ?? energySmoothTheme.textStyle.fontSize,
          ),
          legend: Math.max(
            12,
            typography ?? energySmoothTheme.legend.textStyle.fontSize,
          ),
          tooltip: energySmoothTheme.tooltip.textStyle.fontSize,
        };
  const fontSize = sizes.label;
  const walk = (
    node: unknown,
    parent = "",
    tier: "label" | "legend" | "tooltip" = "label",
  ): unknown => {
    if (parent === "tooltip" || parent === "legend") tier = parent;
    const minimum = sizes[tier];
    if (Array.isArray(node))
      return node.map((value) => walk(value, parent, tier));
    if (!node || typeof node !== "object") return node;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] =
        key === "fontSize" && typeof value === "number"
          ? Math.max(value, minimum)
          : walk(value, key, tier);
    }
    if (["axisLabel", "nameTextStyle", "textStyle", "label"].includes(parent))
      result.fontSize = Math.max(Number(result.fontSize) || 0, minimum);
    if (
      mobile &&
      parent === "xAxis" &&
      result.type === "value" &&
      result.max === 23
    )
      result.interval = 6;
    if (["xAxis", "yAxis"].includes(parent)) {
      result.axisLabel = {
        ...((result.axisLabel as object) ?? {}),
        fontSize,
      };
      result.nameTextStyle = {
        ...((result.nameTextStyle as object) ?? {}),
        fontSize,
      };
    }
    return result;
  };
  return {
    ...(walk(option) as EChartsOption),
    textStyle: {
      ...option.textStyle,
      fontSize,
    },
    tooltip: {
      ...option.tooltip,
      textStyle: {
        ...(option.tooltip as { textStyle?: object })?.textStyle,
        fontSize: sizes.tooltip,
      },
    },
  };
}
/** Page-local wrapper: instance survives scenario/time changes, incremental merge only. */
export function SmoothChart({
  option,
  label,
  className,
}: {
  option: EChartsOption;
  label: string;
  className: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const latest = useRef(option);
  const seriesSignature = useRef<string | null>(null);
  latest.current = option;
  const update = () => {
    const mobile = window.matchMedia("(max-width: 640px)").matches;
    const next = smoothOption(
      mobileReadableOption(
        latest.current,
        mobile,
        host.current ? readChartTypography(host.current) : undefined,
      ),
    );
    const signature = JSON.stringify(
      (next.series as { id?: string; type?: string }[]).map(({ id, type }) => [
        id,
        type,
      ]),
    );
    // Merge updated samples/axes into the existing instance. Only a changed
    // series inventory needs replacement; preserve axes, zoom and chart ID.
    chart.current?.setOption(next, {
      ...INCREMENTAL_UPDATE,
      ...(seriesSignature.current !== null &&
      seriesSignature.current !== signature
        ? { replaceMerge: ["series"] }
        : {}),
    });
    seriesSignature.current = signature;
    if (host.current) host.current.dataset.minimumChartFont = "12";
  };
  useEffect(() => {
    if (!host.current) return;
    registerEnergySmoothTheme(host.current);
    const instance = echarts.init(host.current, "energy-smooth");
    chart.current = instance;
    const removeTooltipTypography = installRichTooltipTypography(instance);
    host.current.dataset.chartId = instance.id;
    const media = window.matchMedia("(max-width: 640px)");
    media.addEventListener("change", update);
    const observer = new ResizeObserver(() => {
      instance.resize();
      update();
    });
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      removeTooltipTypography();
      media.removeEventListener("change", update);
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    update();
  }, [option]);
  return <div ref={host} className={className} role="img" aria-label={label} />;
}
