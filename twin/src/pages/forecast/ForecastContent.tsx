import { useMemo } from "react";
import type { ModelCard } from "../../data/types";
import { Card } from "../../components/Card";
import { PageGrid } from "../../components/PageGrid";
import { AnimatedValue } from "./AnimatedValue";
import { Plot } from "./Plot";
import { confidenceOption, floorOption } from "./charts";
import {
  ForecastWindowPlot,
  type ForecastPlayback,
} from "./ForecastWindowPlot";
import {
  modelRows,
  primaryModelKeys,
  confidenceThresholds,
  number,
  peakPoint,
  percent,
  rejectedSlots,
  timeLabel,
} from "./data";
import type { ForecastPoint, ForecastView } from "./types";
import { replayCalendar } from "../../ui/replayCalendar";
import { displayConclusions } from "../displayConclusions";
import {
  formatDisplayDate,
  formatDisplayTimestamp,
} from "../../config/presentation";

function Metric({
  label,
  value,
  hint,
  tone = "",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  const match = value.match(/^(.*?)(?:\s+(kW)|(%))$/);
  return (
    <div className={`forecast-metric ${tone}`}>
      <dt>{label}</dt>
      <dd>
        <AnimatedValue text={match ? match[1] : value} />
        {match && (
          <small className="forecast-unit" data-unit={match[2] ?? match[3]}>
            {"\u00a0"}
            {match[2] ?? match[3]}
          </small>
        )}
      </dd>
      {hint && <small>{hint}</small>}
    </div>
  );
}
function ForecastTable({
  view,
  labelOrigin,
}: {
  view: ForecastView;
  labelOrigin: string;
}) {
  return (
    <details className="forecast-details">
      <summary>查看滚动窗口数据（26 点）</summary>
      <div
        className="forecast-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="滚动预测数据表"
      >
        <table>
          <thead>
            <tr>
              {[
                "时刻",
                "类型",
                "负荷 / kW",
                "90% 区间 / kW",
                "置信度",
                "判定",
              ].map((h) => (
                <th scope="col" key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.recent_actual.map((p) => (
              <tr key={`actual-${p.t}`}>
                <th scope="row">{timeLabel(p.t, labelOrigin)}</th>
                <td>原始观测</td>
                <td>{number(p.actual_kw)}</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
              </tr>
            ))}
            {view.forecast_24h.map((p) => (
              <tr
                key={p.t}
                data-slot-t={p.t}
                data-realized-abstain={p.realized_abstain === true}
              >
                <th scope="row">{timeLabel(p.t, labelOrigin)}</th>
                <td>预测</td>
                <td>{number(p.point_kw)}</td>
                <td>
                  {number(p.lower_kw)} – {number(p.upper_kw)}
                </td>
                <td>{percent(p.confidence)}</td>
                <td>{p.realized_abstain ? "拒绝 · 转人工" : "可信"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
export function ForecastContent({
  view,
  current,
  floors,
  modelCard,
  scenario,
  nowMs,
  labelOrigin = view.current_t,
  playback,
}: {
  view: ForecastView;
  current: ForecastPoint;
  floors: number[];
  modelCard: ModelCard | null;
  scenario: string;
  nowMs: number;
  labelOrigin?: string;
  playback?: ForecastPlayback;
}) {
  const calendar = replayCalendar(scenario, view.current_t, nowMs).text;
  const show = (text: string) => displayConclusions(calendar(text));
  const floorChart = useMemo(() => floorOption(floors), [floors]);
  const peak = peakPoint(view);
  const rejected = rejectedSlots(view);
  const allRows = modelRows(modelCard);
  const rows = allRows.filter(
    (r) => primaryModelKeys.includes(r.key) && r.key !== "cross_building_coverage",
  );
  const transferRow = allRows.find((r) => r.key === "cross_building_coverage");
  const confidenceChart = useMemo(
    () => confidenceOption(view, labelOrigin),
    [view, labelOrigin],
  );
  const thresholds = confidenceThresholds(view);
  const actual = view.recent_actual[1];
  return (
    <div
      className="forecast-root"
      data-source={view.source}
      data-current-t={view.current_t}
      data-display-date={formatDisplayDate(nowMs)}
      aria-description={formatDisplayTimestamp(nowMs)}
    >
      <PageGrid
        className="forecast-page"
        rows="auto auto auto auto"
        areas={["main", "model", "risk", "floors"]}
        breakpoints={[
          {
            minWidth: 760,
            columns: "repeat(2, minmax(0, 1fr))",
            rows: "auto auto auto",
            areas: ["main main", "model risk", "floors floors"],
          },
          {
            minWidth: 1180,
            columns: "repeat(3, minmax(0, 1fr))",
            rows: "minmax(0, 1.15fr) minmax(0, 1fr)",
            areas: ["main main main", "model risk floors"],
          },
        ]}
      >
        <Card label="24 小时负荷预测" className="forecast-main">
          <header className="forecast-heading">
            <div>
              <h2>24 小时负荷预测</h2>
              <p>t−1、t 原始观测 · t+1 至 t+24 预测 · 90% 区间</p>
            </div>
            <span className="forecast-badge">滚动预测 · 24h</span>
          </header>
          <PageGrid
            className="forecast-upper"
            rows="auto auto"
            breakpoints={[
              {
                minWidth: 850,
                columns: "minmax(0, 4.8fr) minmax(18rem, 1fr)",
                rows: "minmax(0, 1fr)",
              },
            ]}
          >
            <div className="forecast-chart-column">
              <ForecastWindowPlot
                view={view}
                labelOrigin={labelOrigin}
                playback={playback}
                label={`滚动负荷预测：当前 ${timeLabel(view.current_t, labelOrigin)}；白线为两个原始观测点，青线为未来24小时预测，青色带为90%预测区间，红色区域为拒绝预测，青色虚线为当前时刻。峰值 ${number(peak.point_kw)} kW，${timeLabel(peak.t, labelOrigin)}。`}
              />
              <div className="forecast-key">
                <span>
                  <i className="actual" />
                  原始观测
                </span>
                <span>
                  <i className="future" />
                  预测
                </span>
                <span>
                  <i className="band" />
                  90% 区间
                </span>
                <span>
                  <i className="reject" />
                  拒绝 · 转人工
                </span>
                <span>
                  <i className="cursor" />
                  当前 t
                </span>
              </div>
              <ForecastTable view={view} labelOrigin={labelOrigin} />
            </div>
            <dl className="forecast-metrics">
              <Metric
                label="当前预计负荷"
                value={`${number(current.point_kw)} kW`}
                hint={`t · ${timeLabel(view.current_t, labelOrigin)}`}
                tone="cyan"
              />
              <Metric
                label="90% 区间"
                value={`${number(current.lower_kw)} – ${number(current.upper_kw)} kW`}
                hint="当前预测区间"
              />
              <Metric
                label="区间宽度"
                value={`${number(current.upper_kw - current.lower_kw)} kW`}
              />
              <Metric
                label="原始观测"
                value={`${number(actual.actual_kw)} kW`}
                hint={`t · ${timeLabel(actual.t, labelOrigin)}`}
              />
              <Metric
                label="置信度"
                value={percent(current.confidence)}
                tone="cyan"
              />
              <Metric
                label="模型判定"
                value={current.abstain ? "拒绝预测" : "可信范围内"}
                hint={
                  current.abstain ? "暂停自动下发 · 转人工" : "通过预测门控"
                }
                tone={current.abstain ? "danger" : "success"}
              />
              <Metric
                label="未来 24h 预计峰值"
                value={`${number(peak.point_kw)} kW`}
                hint={timeLabel(peak.t, labelOrigin)}
                tone="cyan"
              />
            </dl>
          </PageGrid>
        </Card>

        <Card label="模型可信度" className="forecast-model">
          <header className="forecast-heading">
            <div>
              <h2>模型可信度</h2>
              <p>模型指标</p>
            </div>
          </header>
          <div
            className="forecast-table-scroll forecast-model-scroll"
            tabIndex={0}
            role="region"
            aria-label="模型可信度指标表"
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">指标</th>
                  <th scope="col">数值 / 说明</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row">{r.label}</th>
                    <td>{show(r.value)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">运行模式</th>
                  <td>
                    <span className="forecast-badge success">自动调度</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {transferRow && (
            <section className="forecast-transfer" aria-label="另一栋楼的迁移评测">
              <h3>另一栋楼的迁移评测</h3>
              <p>独立迁移评测汇总，不属于本楼指标或验收结果。</p>
              <dl>
                <dt>保留样本覆盖率</dt>
                <dd>{transferRow.value}</dd>
              </dl>
            </section>
          )}
        </Card>
        <Card label="拒绝时段分析" className="forecast-risk">
          <header className="forecast-heading">
            <div>
              <h2>拒绝时段分析</h2>
              <p>未来 24 小时 · {rejected.length} 个拒绝时段</p>
            </div>
            <span
              className={`forecast-badge ${rejected.length ? "danger" : "success"}`}
            >
              {rejected.length ? "需人工复核" : "全部可信"}
            </span>
          </header>
          <p className="forecast-risk-summary-line">
            {rejected.length
              ? `未来 24 小时预计有 ${rejected.length} 个拒绝时段，请核对逐小时评分和详情。`
              : "未来 24 小时预计均在可信范围内"}
          </p>
          <details className="forecast-details">
            <summary>查看拒绝时段详情</summary>
            <div
              className="forecast-table-scroll forecast-rejection-scroll"
              tabIndex={0}
              role="region"
              aria-label="拒绝时段表"
            >
              <table className="forecast-rejections">
                <thead>
                  <tr>
                    {["时段", "区间宽度", "主要原因"].map((h) => (
                      <th scope="col" key={h}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rejected.map((r) => (
                    <tr key={r.t}>
                      <th scope="row">
                        {timeLabel(r.t, labelOrigin)} –{" "}
                        {timeLabel(r.end, labelOrigin)}
                      </th>
                      <td>{number(r.width_kw)} kW</td>
                      <td>{show(r.reason)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <div className="forecast-confidence">
            <h3>未来 24h 置信度评分</h3>
            <Plot
              option={confidenceChart}
              className="forecast-confidence-plot"
              label="未来24小时每小时置信度评分柱图，纵轴按评分与阈值局部缩放，非零起点；金色虚线为对应时域门控阈值，拒绝时段为红柱。逐小时数值见滚动窗口数据表。"
            />
            <div className="forecast-confidence-key">
              <span>青柱：通过门控 · 红柱：拒绝</span>
              <span>
                金虚线：
                {thresholds.every((v) => v === null)
                  ? "阈值暂无数据"
                  : "门控阈值"}
              </span>
            </div>
          </div>
        </Card>
        <Card label="40 层负荷" className="forecast-floors">
          <header className="forecast-heading">
            <div>
              <h2>40 层负荷</h2>
              <p>当前小时 · kW</p>
            </div>
          </header>
          <Plot
            option={floorChart}
            className="forecast-floor-plot"
            label="40层分配负荷柱状图；纵轴从零起，柱颜色由蓝到青到金表示负荷升高。"
          />
          <div className="forecast-load-key">
            <span>低负荷</span>
            <i />
            <span>高负荷 · kW</span>
          </div>
          <details className="forecast-details">
            <summary>查看 40 层负荷数据</summary>
            <div
              className="forecast-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="40层负荷数据表"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">楼层</th>
                    <th scope="col">分配负荷 / kW</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: 40 }, (_, i) => (
                    <tr key={i}>
                      <th scope="row">{number(i + 1, 0)}F</th>
                      <td>
                        {Number.isFinite(floors[i])
                          ? number(floors[i])
                          : "暂无数据"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Card>
      </PageGrid>
    </div>
  );
}
