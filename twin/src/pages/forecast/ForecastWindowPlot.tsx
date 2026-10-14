import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ECharts } from "echarts";
import type { ReplayData } from "../../data/types";
import { overviewWindow } from "../../data/overviewForecast";
import type { DashboardStore } from "../../state/store";
import type { ForecastView } from "./types";
import { forecastOption, playbackForecastOption } from "./charts";
import { Plot } from "./Plot";

export interface ForecastPlayback {
  data: ReplayData;
  store: DashboardStore;
  startMs: number | null;
  elapsedHours: number;
  playing: boolean;
}
export function ForecastWindowPlot({
  view,
  labelOrigin,
  label,
  playback,
}: {
  view: ForecastView;
  labelOrigin: string;
  label: string;
  playback?: ForecastPlayback;
}) {
  const start = playback?.startMs == null ? null : new Date(playback.startMs);
  const startHour = start
    ? start.getHours() + start.getMinutes() / 60 + start.getSeconds() / 3600
    : null;
  const frame = playback?.store.getPlaybackFrame();
  const elapsed = frame?.elapsedHours ?? playback?.elapsedHours ?? 0;
  const window =
    startHour === null || !playback
      ? null
      : overviewWindow(playback.data, 0, { startHour, elapsedHours: elapsed });
  const origin = window?.origin ?? 0;
  const headHour = window ? Math.floor(window.head) : 0;
  const baseTime = playback?.data.hours[origin]?.t ?? view.current_t;
  const option = useMemo(
    () =>
      window
        ? playbackForecastOption(
            view,
            window.slots,
            baseTime,
            origin,
            window.head,
          )
        : forecastOption(view, labelOrigin),
    [view, labelOrigin, playback?.data, baseTime, origin, headHour, startHour],
  );
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const line = useRef<HTMLSpanElement>(null);
  const updateHead = useCallback(() => {
    if (startHour === null || !playback || !chart.current || !line.current)
      return;
    const head = startHour + playback.store.getPlaybackFrame().elapsedHours;
    const instance = chart.current;
    const model = instance.getOption();
    // Use the actual horizontal axis transform for continuous head positioning.
    const x = instance.convertToPixel({ xAxisIndex: 0 }, head);
    const grid = (model.grid as { top: number; bottom: number }[])[0];
    const top = typeof grid.top === "number" ? grid.top : 30;
    const bottom = typeof grid.bottom === "number" ? grid.bottom : 28;
    line.current.style.transform = `translateX(${x}px)`;
    line.current.style.top = `${top}px`;
    line.current.style.height = `${Math.max(0, instance.getHeight() - top - bottom)}px`;
    line.current.dataset.head = String(head);
  }, [playback?.store, startHour]);
  const ready = useCallback(
    (instance: ECharts | null) => {
      chart.current = instance;
      updateHead();
    },
    [updateHead],
  );
  useEffect(() => {
    updateHead();
    return playback?.store.subscribePlayback(updateHead);
  }, [playback?.store, updateHead, option]);
  return (
    <div ref={host} className="forecast-plot forecast-window-host">
      <Plot
        option={option}
        label={
          window
            ? "固定24小时窗口：已播放实测与剩余预测，红区按对应时段门控结果"
            : label
        }
        className="forecast-window-plot"
        onReady={ready}
      />
      {window && (
        <span
          ref={line}
          className="forecast-window-playhead"
          aria-hidden="true"
        />
      )}
      <span
        hidden
        data-window-axis-start={window?.slots[0].t ?? -1}
        data-window-axis-end={window?.slots.at(-1)?.t ?? 24}
        data-window-actual-count={
          window?.slots.filter((p) => p.actual !== null).length ?? 2
        }
      />
    </div>
  );
}
