import { useMemo, useEffect, useRef, useCallback } from "react";
import type { EChartsOption, ECharts } from "echarts";
import type { ReplayData } from "../data/types";
import { overviewWindow, playbackWindowScale, type OverviewPlayback } from '../data/overviewForecast';
import type { DashboardStore } from '../state/store';
import './replayChart.css';
import {formatRelativeTime,hourOnDisplayDay} from '../config/displayTime';
import {niceIntegerScale} from '../ui/chartScale';
import { EChart } from "./EChart";
import {chartPlotRect} from './chartPlotRect';
import {formatNumber as n, roundDisplay as round} from '../ui/numberFormat';
export function ReplayChart({
  data,
  time,
  playing = false,
  store,
  playbackStartMs = null,
  playbackElapsedHours = 0,
  nowMs = Date.now(),
}: {
  data: ReplayData;
  time: number;
  playing?: boolean;
  store?: DashboardStore;
  playbackStartMs?: number|null;
  playbackElapsedHours?: number;
  nowMs?: number;
}) {
  const start=playbackStartMs===null?null:new Date(playbackStartMs);
  const startHour=start ? start.getHours()+start.getMinutes()/60+start.getSeconds()/3600 : null;
  const elapsed=store?.getPlaybackFrame().elapsedHours ?? playbackElapsedHours;
  const origin=Math.floor(startHour===null?time:startHour+elapsed);
  const playback=startHour===null?undefined:{startHour,elapsedHours:elapsed};
  const option = useMemo(
    () => ({...overviewForecastOption(data, time, playback, {displayMs:nowMs,baseMs:playbackStartMs??nowMs}),animation:!playing}),
    [data, origin, startHour, playing],
  );
  const chart=useRef<ECharts|null>(null),line=useRef<HTMLSpanElement>(null);
  const geometry=useRef<{left:number;right:number;top:number;bottom:number}|null>(null);
  const updateHead=useCallback(()=>{
    if(startHour===null||!line.current||!geometry.current)return;
    const frame=store?.getPlaybackFrame();const head=startHour+(frame?.elapsedHours??playbackElapsedHours),g=geometry.current;
    const fraction=Math.max(0,Math.min(1,(head-(Math.floor(startHour)-1))/25));
    line.current.style.transform=`translateX(${g.left+(g.right-g.left)*fraction}px)`;
    line.current.style.top=`${g.top}px`;line.current.style.height=`${g.bottom-g.top}px`;
    line.current.dataset.head=String(head);
  },[store,startHour,playbackElapsedHours]);
  const ready=useCallback((instance:ECharts|null)=>{
    chart.current=instance;if(!instance){geometry.current=null;return;}
    geometry.current=chartPlotRect(instance);
    updateHead();
  },[option,updateHead]);
  useEffect(()=>store?.subscribePlayback(updateHead),[store,updateHead]);
  const view=overviewWindow(data,time,playback);
  return (
    <div
      className="replay-chart"
      data-time={time}
      data-actual-count={view.slots.filter(p=>p.actual!==null).length}
      data-forecast-count={view.slots.filter(p=>p.t>Math.floor(view.head)).length}
      data-origin={origin}
      data-axis-start={view.slots[0].t}
      data-axis-end={view.slots.at(-1)!.t}
    >
      <EChart label={playback?'固定24小时窗口：已播放实测与剩余预测':'滚动预测：最近两点实测与未来24点预测'} option={option} onReady={ready} phased={playing} />
      {playback && <span ref={line} className="forecast-playhead" aria-hidden="true" />}
    </div>
  );
}
export function overviewForecastOption(
  data: ReplayData,
  time: number,
  playback?: OverviewPlayback,
  calendar={displayMs:Date.now(),baseMs:Date.now()},
): EChartsOption {
  const window=overviewWindow(data,time,playback);
  const slots=window.slots;
  const times=slots.map(p=>p.t);
  const values=slots.flatMap(p=>[p.actual,p.lower,p.upper]).filter((value):value is number=>value!==null);
  const low = Math.min(...values),
    high = Math.max(...values);
  const scale=playback?playbackWindowScale(data,playback.startHour):niceIntegerScale(low,high);
  return {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 280,
    animationEasingUpdate: "cubicOut",
    grid: { left: 8, right: 60, top: 34, bottom: 12, containLabel: true },
    tooltip: {
      trigger:'axis',
      formatter: (params) => {
        const rows=Array.isArray(params)?params:[params];
        const first=rows[0] as {axisValue?:string|number;name?:string};
        const index=times.indexOf(Number(first?.axisValue ?? first?.name));
        if(index<0)return '';
        const t=times[index];
        const clock=formatRelativeTime(hourOnDisplayDay(calendar.baseMs,t),calendar.displayMs);
        const point=slots[index];
        const rejection=point.realized_abstain?'\n拒绝预测':'';
        if(point.actual!==null)return `${clock}\n实测：${n(point.actual)} kW${rejection}`;
        return `${clock}\n预测：${n(point.point!)} kW\n预测下限：${n(point.lower!)} kW\n预测上限：${n(point.upper!)} kW${rejection}`;
      },
    },
    legend: {
      data: ["实测", "预测"],
      textStyle: { color: "#91a9b9", fontSize: 12 },
      top: 0,
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: times.map(String),
      axisLabel: {
        // Wider 12px relative-day labels need more space near the forced end tick.
        interval: 7,
        showMaxLabel:true,
        hideOverlap: true,
        fontSize: 12,
        formatter: (value) => formatRelativeTime(hourOnDisplayDay(calendar.baseMs,Number(value)),calendar.displayMs),
      },
    },
    yAxis: {
      type: "value",
      scale: true,
      ...scale,
      splitNumber: 4,
      axisLabel: { fontSize: 12, showMinLabel:false,showMaxLabel:false,formatter:(value:number)=>n(value,0) },
    },
    series: [
      {
        id: "overview-lower",
        name: "预测下限",
        type: "line",
        stack: "interval",
        data: slots.map(p=>p.lower===null?null:round(p.lower)),
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        silent: true,
      },
      {
        id: "overview-width",
        name: "预测上限",
        type: "line",
        stack: "interval",
        data: slots.map(p=>p.upper===null||p.lower===null?null:round(p.upper-p.lower)),
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { color: "#56bbc3", opacity: 0.18 },
        silent: true,
      },
      {
        id: "overview-forecast",
        type: "line",
        name: "预测",
        showSymbol: false,
        data: slots.map(p=>p.point===null?null:round(p.point)),
        lineStyle: { color: "#f1b86a", width: 2 },
        markArea: {
          silent: true,
          itemStyle: { color: "#ff4d5e22" },
          data: slots.flatMap((p, i) =>
            p.realized_abstain ? [[{ xAxis: i - 0.5 }, { xAxis: i + 0.5 }]] : [],
          ),
        },
      },
      {
        id: "overview-rejections",
        name: "拒绝预测",
        type: "scatter",
        data: slots
          .filter((p) => p.realized_abstain)
          .map((p) => [String(p.t), round(p.actual??p.point!)]),
        symbolSize: 5,
        itemStyle: { color: "#ff4d5e" },
      },
      {
        id: "overview-actual",
        type: "line",
        name: "实测",
        showSymbol: true,
        symbolSize: 5,
        data: slots.map(p=>p.actual===null?null:round(p.actual)),
        lineStyle: { color: "#4fd1d9" },
        markLine: {
          symbol: "none",
          label: { show: false },
          lineStyle: { color: "#fff2bd" },
          data: playback?[]:[{ xAxis: String(window.origin) }],
        },
      },
    ],
  };
}
