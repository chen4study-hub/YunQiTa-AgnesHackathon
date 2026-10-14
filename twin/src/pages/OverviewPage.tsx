import { useMemo, memo } from "react";
import './overview-metrics.css';
import { PageGrid } from "../components/PageGrid";
import { Card } from "../components/Card";
import { OverviewStatusText } from '../components/OverviewStatusText';
import { OverviewScene } from "../components/OverviewScene";
import { OverviewVerdict } from "../components/OverviewVerdict";
import { ReplayChart } from "../components/ReplayChart";
import { AnimatedNumberText } from "../components/AnimatedNumberText";
import { useDashboard } from "../state/context";
import { sampleFrame, clockTime } from "../data/interpolate";
import {
  cumulativeEnergy,
  daySummary,
  peakTariff,
  formatNumber as n,
} from "../data/overview";

import { useOpsDay } from '../data/ops/useOpsDay';

export const OverviewPage=memo(function OverviewPage() {
  const { state, store } = useDashboard(1);
  const data = state.data;
  const frame = useMemo(
    () => (data ? sampleFrame(data, state.time) : null),
    [data, state.time],
  );
  const opsDay = useOpsDay(store.getPlaybackFrame().nowMs);
  const schedule = opsDay?.meta.tariff ?? null;
  const summary = useMemo(() => (data ? daySummary(data,schedule) : null), [data,schedule]);
  const peakPrice = peakTariff(schedule);
  if (!data || !frame || !summary)
    return <div className="placeholder-surface">数据加载中…</div>;
  const h = frame.hour;
  return (
    <PageGrid
      columns="minmax(0, 1fr)"
      rows="auto"
      areas={["metrics", "scene", "operations"]}
      breakpoints={[
        {
          minWidth: 1180,
          columns: "minmax(0, 1.1fr) minmax(0, 1.7fr) minmax(0, 1.4fr)",
          rows: "minmax(0, 1fr)",
          areas: ["metrics scene operations"],
        },
        {
          minWidth: 1750,
          columns: "minmax(0, .82fr) minmax(0, 2fr) minmax(0, 1.15fr)",
        },
        {
          minWidth: 2200,
          columns: "minmax(0, 1fr) minmax(0, 2.6fr) minmax(0, 1.3fr)",
        },
      ]}
      className="overview-grid"
    >
      <div className="overview-left page-enter" style={{ gridArea: "metrics" }}>
        <Card label="预测负荷" className="overview-metric">
          <small>预测负荷</small>
          <strong className="type-number overview-number">
            <AnimatedNumberText
              text={n(h.point_kw, 1)}
              immediate={state.playing || state.time % 1 !== 0}
            />
            <em className="type-unit">{'\u00a0'}kW</em>
          </strong>
          <p>
            区间{" "}
            <AnimatedNumberText
              text={`${n(h.lower_kw, 1)} – ${n(h.upper_kw, 1)} kW`}
              immediate={state.playing || state.time % 1 !== 0}
            />
          </p>
        </Card>
        <Card label="今日累计用电" className="overview-metric">
          <small>今日累计用电</small>
          <strong className="type-number overview-number">
            <AnimatedNumberText
              text={n(cumulativeEnergy(data, state.time), 1)}
              immediate={state.playing || state.time % 1 !== 0}
            />
            <em className="type-unit">{'\u00a0'}kWh</em>
          </strong>
          <p className="overview-actual">当前实测 <AnimatedNumberText text={`${n(h.actual_kw, 1)} kW`} immediate={state.playing || state.time % 1 !== 0} /> · 截至 {clockTime(state.time)}</p>
        </Card>
        <Card label="今日预计电费" className="overview-metric">
          <small>今日预计电费</small>
          <strong className="type-number overview-number">
            <AnimatedNumberText text={summary.estimatedCost===null?'—':n(summary.estimatedCost, 1)} immediate={state.playing} />
            <em className="type-unit">{'\u00a0'}元</em>
          </strong>
          <p><OverviewStatusText text={peakPrice===null?'电价数据缺失':`峰时电价 ${peakPrice.toFixed(2)} 元/kWh`} /></p>
        </Card>
        <Card
          label="模型状态"
          className={`overview-metric model-status ${h.abstain ? "rejected" : ""}`}
        >
          <small>模型状态</small>
          <strong><OverviewStatusText text={h.abstain ? "拒绝预测" : "正常"} /></strong>
          <p>
            置信度{" "}
            <AnimatedNumberText
              text={`${n(h.confidence * 100, 1)}%`}
              immediate={state.playing || state.time % 1 !== 0}
            />{" "}
            · <OverviewStatusText text={h.abstain ? "转人工复核" : "正常运行"} />
          </p>
        </Card>
        <Card label="今日概况" className="daily-summary">
          <h2>今日概况</h2>
          <div className="summary-grid">
            <div>
              <small>预测峰值</small>
              <b>
                <AnimatedNumberText text={`${n(summary.peak, 1)} kW`} immediate={state.playing} />
              </b>
            </div>
            <div>
              <small>峰值时刻</small>
              <b>{String(summary.peakHour).padStart(2, "0")}:00</b>
            </div>
            <div>
              <small>拒绝时段数</small>
              <b>{summary.rejected} 时段</b>
            </div>
            <div>
              <small><OverviewStatusText text="自动调度 / 转人工" /></small>
              <b>
                {summary.executed} / {summary.handoff} 次
              </b>
            </div>
          </div>
          <p>全天统计</p>
        </Card>
      </div>
      <OverviewScene />
      <div
        className="overview-right page-enter"
        style={{ gridArea: "operations" }}
      >
        <PhasedVerdict />
        <PhasedForecast />
      </div>
    </PageGrid>
  );
});
const PhasedVerdict=memo(function PhasedVerdict(){
 const {state,store}=useDashboard(4);const frame=useMemo(()=>state.data?sampleFrame(state.data,state.time):null,[state.data,state.time]);if(!frame)return null;
 return <OverviewVerdict scenario={state.scenario} hour={frame.hour} time={state.time} nowMs={state.nowMs} liveDecision={state.playbackStartMs===null?store.getLiveSchedule():null}/>;
});
const PhasedForecast=memo(function PhasedForecast(){
 const {state,store}=useDashboard(6);if(!state.data)return null;
 return <Card label="24 小时预测" className="overview-forecast"><div className="overview-forecast-heading"><h2>24 小时预测</h2><small>{state.playbackStartMs===null?'最近 2 点实测 + 未来 24 点预测':'固定窗口 · 已播放实测 + 剩余预测'}</small></div><ReplayChart data={state.data} time={state.time} playing={state.playing} store={store} playbackStartMs={state.playbackStartMs} playbackElapsedHours={state.playbackElapsedHours} nowMs={state.nowMs}/></Card>;
});
