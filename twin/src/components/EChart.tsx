import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { darkTheme } from "../ui/chartTheme";
import { observeSize } from "./observeSize";
import { updateChart } from "./chartUpdate";
import { phaseChartUpdate } from "./chartPhases";

echarts.registerTheme("yunqi-dark", darkTheme);

interface EChartProps {
  option: echarts.EChartsOption;
  label: string;
  className?: string;
  onReady?: (instance: echarts.ECharts | null) => void;
  phased?: boolean;
}

export function EChart({
  option,
  label,
  className = "",
  onReady,
  phased = false,
}: EChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.ECharts | null>(null);
  const latestOption = useRef(option);
  latestOption.current = option;
  const ready = useRef(onReady);
  ready.current = onReady;
  const visible = useRef(false);
  const appliedOption = useRef<echarts.EChartsOption | undefined>(undefined);

  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (instance.current && visible.current) {
        updateChart(instance.current, latestOption.current, media.matches);
        appliedOption.current = latestOption.current;
      }
    };
    let renderedWidth = 0,
      renderedHeight = 0;
    let resumeFrame = 0,
      resumeTask: ReturnType<typeof setTimeout> | undefined;
    const cancelResume = () => {
      cancelAnimationFrame(resumeFrame);
      if (resumeTask !== undefined) clearTimeout(resumeTask);
    };
    const stop = observeSize(element, ({ width, height }) => {
      const wasVisible = visible.current;
      visible.current = width > 0 && height > 0;
      if (!visible.current) {
        cancelResume();
        return;
      }
      if (!instance.current) {
        renderedWidth = width;
        renderedHeight = height;
        instance.current = echarts.init(element, "yunqi-dark", {
          width,
          height,
        });
        instance.current.on("rendered", () => {
          if (instance.current) ready.current?.(instance.current);
        });
        apply();
      } else {
        // Keep the existing backing canvas when a mounted page returns unchanged.
        if (width !== renderedWidth || height !== renderedHeight) {
          instance.current.resize({ width, height });
          renderedWidth = width;
          renderedHeight = height;
        }
        if (!wasVisible && appliedOption.current !== latestOption.current) {
          // Restore the retained chart first. Catch up hidden-page data after
          // navigation's two paint opportunities, not in its size callback.
          cancelResume();
          resumeFrame = requestAnimationFrame(() => {
            resumeTask = setTimeout(() => {
              if (appliedOption.current !== latestOption.current) apply();
            }, 0);
          });
        }
      }
    });
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      cancelResume();
      stop();
      ready.current?.(null);
      instance.current?.dispose();
      visible.current = false;
      instance.current = null;
    };
  }, []);

  useEffect(() => {
    if (appliedOption.current === option) return;
    if (phased && visible.current && instance.current)
      return phaseChartUpdate(
        instance.current,
        option,
        true,
        appliedOption.current,
        () => {
          appliedOption.current = option;
        },
      );
    // Keep ECharts setOption/model work off the React hourly commit frame.
    const raf = requestAnimationFrame(() => {
      if (
        visible.current &&
        instance.current &&
        appliedOption.current !== latestOption.current
      ) {
        updateChart(
          instance.current,
          latestOption.current,
          matchMedia("(prefers-reduced-motion: reduce)").matches,
        );
        appliedOption.current = latestOption.current;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [option, phased]);

  return (
    <div
      ref={host}
      className={`echart ${className}`}
      role="img"
      aria-label={label}
    />
  );
}
