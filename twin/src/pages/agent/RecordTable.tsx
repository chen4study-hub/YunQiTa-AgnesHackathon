import type { ReactNode } from "react";
import { Card } from "../../components/Card";
import type { ReplayData } from "../../data/types";
import type { Decision, RecordStatus } from "./types";
import {
  n,
  elapsedMs,
  recentHours,
  replayDecision,
  storagePower,
} from "./data";
import { timeLabel } from "../forecast/data";
import { AnimatedValue } from "../forecast/AnimatedValue";
export function RecordTable({
  data,
  previous,
  index,
  current,
  statuses,
  decisions = {},
  labelOrigin = current.t,
  headerTabs,
  connected = false,
}: {
  data: ReplayData;
  previous?: ReplayData | null;
  index: number;
  current: Decision;
  statuses: Record<string, RecordStatus>;
  decisions?: Record<string, Decision>;
  labelOrigin?: string;
  headerTabs?: ReactNode;
  connected?: boolean;
}) {
  return (
    <Card label="近期决策记录" className="agent-record-card">
      <header className="agent-heading">
        <div>
          <h2>近期决策记录</h2>
          <small>最近 6 小时 · 截至 {timeLabel(current.t, labelOrigin)}</small>
        </div>
        {headerTabs}
      </header>
      <div
        className="agent-table-scroll"
        role="region"
        aria-label="最近6小时决策表"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              {["时间", "类型", "内容", "状态", "执行耗时"].map((h) => (
                <th scope="col" key={h}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {recentHours(data, index, previous)
              .reverse()
              .map(
                (
                  { hour, index: i, t, data: source, previous: isPrevious },
                  slot,
                ) => {
                  const receiptDecision = isPrevious
                      ? replayDecision(source, i)
                      : i === index
                        ? current
                        : (decisions[hour.t] ?? replayDecision(source, i)),
                    d = receiptDecision,
                    status = isPrevious ? undefined : statuses[hour.t];
                  return (
                    <tr
                      key={slot}
                      data-record-t={hour.t}
                      data-display-t={t}
                      data-record-scenario={source.meta.scenario}
                    >
                      <th scope="row">{timeLabel(t, labelOrigin)}</th>
                      <td>
                        {d.lifecycle === "manual"
                          ? "人工接管"
                          : d.handoff
                            ? "预测门控"
                            : "自动调度"}
                      </td>
                      <td>
                        <AnimatedValue
                          text={
                            d.lifecycle === "manual"
                              ? `人工接管 · 操作人 ${d.manualOperator ?? "暂无数据"}`
                              : d.handoff
                                ? "预测拒绝"
                                : `温控 ${n(d.temp)} °C · 储能 ${storagePower(d.battery)}`
                          }
                        />
                      </td>
                      <td>
                        <span
                          className={`agent-record-state ${d.handoff || status === "已撤销" ? "agent-red" : "agent-green"}`}
                        >
                          {status ??
                            (d.handoff
                              ? "待处理"
                              : !receiptDecision.receipt.known
                                ? connected
                                  ? "暂无回执"
                                  : "需要连接后端"
                                : receiptDecision.receipt.count
                                  ? "已下发"
                                  : connected
                                    ? "暂无回执"
                                    : "需要连接后端")}
                        </span>
                      </td>
                      <td>
                        <AnimatedValue
                          text={
                            !receiptDecision.receipt.known
                              ? "—"
                              : d.handoff ||
                                  status === "已撤销" ||
                                  receiptDecision.receipt.count === 0
                                ? "—"
                                : receiptDecision.receipt.elapsed === null
                                  ? "暂无数据"
                                  : elapsedMs(receiptDecision.receipt.elapsed)
                          }
                        />
                      </td>
                    </tr>
                  );
                },
              )}
            {recentHours(data, index, previous).length === 0 && (
              <tr>
                <td colSpan={5}>暂无数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
