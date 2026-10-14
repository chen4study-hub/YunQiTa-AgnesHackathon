import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ReplayData } from "../../data/types";
import { Card } from "../../components/Card";
import { LlmStatusBadge } from "./LlmStatusBadge";
import { AnimatedValue } from "../forecast/AnimatedValue";
import type { Decision, RecordStatus } from "./types";
import {
  n,
  pct,
  elapsedMs,
  costWindowLabel,
  decisionSourceLabel,
  decisionSourceTitle,
  decisionReasonLabel,
  storageLabel,
  storagePower,
} from "./data";
import { displayDate as currentDisplayDate } from "../../config/displayClock";
import { ServiceRecordsDialog, type RecordsMode } from "./ServiceRecordsDialog";
import { TakeoverPanel, useTakeover } from "./TakeoverPanel";
import { PlanReason } from "./PlanReason";
import { replayCalendar } from "../../ui/replayCalendar";
import { displayConclusions } from "../displayConclusions";
const wideQuery = "(min-width: 1600px)";
const subscribeWide = (listener: () => void) => {
  const media = window.matchMedia(wideQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
const isWide = () =>
  typeof window !== "undefined" && window.matchMedia(wideQuery).matches;
function PlanNumber({
  value,
  unit,
  signed = false,
}: {
  value: number | null;
  unit: string;
  signed?: boolean;
}) {
  return (
    <strong className="agent-plan-number">
      <AnimatedValue text={signed ? storageLabel(value) : n(value)} />
      <small>
        {"\u00a0"}
        {unit}
      </small>
    </strong>
  );
}

export function DecisionCard({
  decision: summary,
  onRequestDetail,
  data,
  index,
  online,
  pending,
  status,
  onAction,
  displayText,
  headerTabs,
  date = currentDisplayDate(),
  onConnectionChange,
  onTakeoverChanged,
  restoration,
}: {
  decision: Decision;
  onRequestDetail?: () => Promise<Decision>;
  data: ReplayData;
  index: number;
  online?: boolean;
  pending: boolean;
  status?: RecordStatus;
  onAction: (status: RecordStatus) => void;
  displayText?: (text: string) => string;
  labelOrigin?: string;
  headerTabs?: ReactNode;
  date?: string;
  onConnectionChange?: (connected: boolean) => void;
  onTakeoverChanged?: (change: "created" | "cancelled") => void | Promise<void>;
  restoration?: "pending" | "error";
}) {
  const [detailState, setDetailState] = useState<{
    origin: string;
    decision?: Decision;
    error?: boolean;
    loading?: boolean;
  } | null>(null);
  const takeover = useTakeover(date, index),
    takeoverDialog = useRef<HTMLDialogElement>(null);
  useEffect(
    () => onConnectionChange?.(takeover.connected),
    [takeover.connected, onConnectionChange],
  );
  const manual =
    summary.lifecycle === "manual"
      ? { operator_id: summary.manualOperator ?? "暂无数据" }
      : null;
  const [recordsMode, setRecordsMode] = useState<RecordsMode | null>(null);
  const d =
    detailState?.origin === summary.t && detailState.decision
      ? { ...summary, ticket: detailState.decision.ticket }
      : summary;
  const requestTicket = async () => {
    if (!onRequestDetail) {
      ticket.current?.showModal();
      return;
    }
    setDetailState({ origin: summary.t, loading: true });
    ticket.current?.showModal();
    try {
      const decision = await onRequestDetail();
      setDetailState({ origin: summary.t, decision });
    } catch {
      setDetailState({ origin: summary.t, error: true });
    }
  };
  const showCalendar =
    displayText ?? replayCalendar(data.meta.scenario, d.t).text;
  const show = (text: string) => displayConclusions(showCalendar(text));

  const ticket = useRef<HTMLDialogElement>(null);
  const selected = d.candidates.find((c) => c.id === d.selected);
  const hour = data.hours[index];
  // No per-tool latencies are exported here; do not split the dispatch receipt latency.
  const steps = [
    {
      name: "读取预测",
      tool: "get_forecast",
      summary: `置信度 ${pct(d.confidence)}`,
      blocked: false,
    },
    {
      name: "读取环境",
      tool: "get_context",
      summary: `${hour.outdoor_temp_c === null ? "气温暂无数据" : `${n(hour.outdoor_temp_c)} °C`} · SOC ${pct(hour.storage.soc)}`,
      blocked: d.handoff,
    },
    {
      name: "生成候选并校验约束",
      tool: "simulate_schedule + check_constraints",
      summary: d.handoff
        ? "已暂停"
        : !d.candidates.length || d.candidates.some((c) => c.passed === null)
          ? "暂无数据"
          : `${n(d.candidates.filter((c) => c.passed).length, 0)}/${n(d.candidates.length, 0)} 通过`,
      blocked: d.handoff,
    },
    {
      name: "选定方案",
      tool: "select_plan",
      summary: d.handoff ? "转交人工" : (selected?.name ?? "方案名称未提供"),
      blocked: d.handoff,
    },
    {
      name: "核对数字来源",
      tool: "check_grounding",
      summary: d.handoff
        ? "转交值班人员"
        : d.grounding === null
          ? "数字取自预测与环境记录"
          : d.grounding
            ? "核对通过"
            : "核对未通过",
      blocked: d.handoff,
    },
    {
      name: "下发 BA/EMS",
      tool: "dispatch_to_bms",
      summary: d.handoff
        ? "未下发"
        : !takeover.connected
          ? "需要连接后端"
          : d.receipt.known
            ? `${n(d.receipt.count, 0)} 条指令`
            : "请查看执行回执",
      blocked: d.handoff,
      time: takeover.connected && d.receipt.known ? d.receipt.elapsed : null,
    },
  ];
  const wide = useSyncExternalStore(subscribeWide, isWide, () => false);
  const actions = (
    <div className="agent-actions">
      {manual ? (
        <button
          type="button"
          onClick={() => setRecordsMode("receipt")}
          aria-haspopup="dialog"
        >
          查看执行回执
        </button>
      ) : d.handoff ? (
        <>
          <button
            type="button"
            disabled={!takeover.connected || Boolean(takeover.record)}
            onClick={() => takeoverDialog.current?.showModal()}
          >
            人工接管
          </button>
          <button
            type="button"
            disabled={status === "已处理" || status === "已指派"}
            onClick={() => onAction("已指派")}
          >
            指派给值班工程师
          </button>
          <button
            type="button"
            disabled={status === "已处理"}
            onClick={() => onAction("已处理")}
          >
            标记已处理
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setRecordsMode("receipt")}
            aria-haspopup="dialog"
          >
            查看执行回执
          </button>
          <button
            type="button"
            disabled={!takeover.connected || Boolean(takeover.record)}
            onClick={() => takeoverDialog.current?.showModal()}
          >
            人工接管
          </button>
          <button
            type="button"
            disabled={status === "已撤销" || Boolean(manual)}
            onClick={() => onAction("已撤销")}
          >
            撤销
          </button>
        </>
      )}
    </div>
  );
  const sourceLabel = manual
    ? "人工配置"
    : d.selectionSource
      ? decisionSourceLabel(d)
      : "";
  return (
    <Card
      label="Agent 调度决策"
      className={`agent-decision-card agent-redesign ${d.handoff ? "agent-handoff-card" : "agent-auto-card"}`}
    >
      <header className="agent-heading">
        <div>
          <h2>Agent 调度决策</h2>
          <small>
            <span
              className="agent-decision-source"
              title={manual ? "人工接管配置" : decisionSourceTitle(d)}
            >
              {sourceLabel}
            </span>
            <span
              className="agent-request-status"
              title={pending ? "接口查询中" : undefined}
            >
              {takeover.connected ? (
                `${sourceLabel ? " · " : ""}当前时刻`
              ) : (
                <span className="agent-takeover-notice" role="status">
                  {" "}
                  {sourceLabel ? " · " : ""}接管服务暂不可用，请稍后重试
                </span>
              )}
            </span>
          </small>
          <button
            className="agent-records-link"
            type="button"
            onClick={() => setRecordsMode("history")}
          >
            接管历史与日志
          </button>
        </div>
        {headerTabs}
        <div className="agent-tags">
          <LlmStatusBadge online={online} />
        </div>
      </header>
      <TakeoverPanel
        onChanged={onTakeoverChanged}
        date={date}
        hour={index}
        state={takeover}
        dialog={takeoverDialog}
      />
      <div
        className={`agent-status-bar ${manual && !restoration ? "agent-status-reserved" : ""} ${d.handoff && !restoration ? "agent-danger" : "agent-success"}`}
        role="status"
        aria-hidden={manual && !restoration ? true : undefined}
        aria-busy={restoration === "pending"}
        data-restoration={restoration}
      >
        <b className="agent-status-copy">
          <span
            aria-hidden={Boolean(restoration)}
            className={restoration ? "agent-status-hidden" : ""}
          >
            {status ??
              (d.handoff
                ? "转交人工 · 暂停自动下发"
                : !takeover.connected
                  ? "自动方案 · 需要连接后端"
                  : d.receipt.known && d.receipt.count > 0
                    ? "已自动下发 · 执行中"
                    : "自动方案 · 请查看执行回执")}
          </span>
          <span
            aria-hidden={restoration !== "pending"}
            className={restoration !== "pending" ? "agent-status-hidden" : ""}
          >
            自动调度恢复中…
          </span>
          <span
            aria-hidden={restoration !== "error"}
            className={restoration !== "error" ? "agent-status-hidden" : ""}
          >
            暂时拿不到最新调度，请稍后刷新
          </span>
        </b>
        <span
          aria-hidden={Boolean(restoration)}
          className={restoration ? "agent-status-hidden" : ""}
        >
          <AnimatedValue
            text={
              d.handoff
                ? `置信度 ${pct(d.confidence)} · 人工复核`
                : `置信度 ${pct(d.confidence)} ≥ 阈值 ${pct(d.threshold)} · 无需人工确认`
            }
          />
        </span>
      </div>
      <div className="agent-plan">
        <ul>
          <li>
            <span className="agent-plan-label">当前小时区间上界</span>
            <PlanNumber value={d.upper} unit="kW" />
          </li>
          <li>
            <span className="agent-plan-label">BA 温控设定</span>
            <PlanNumber value={d.temp} unit="°C" />
          </li>
          <li>
            <span className="agent-plan-label">EMS 储能</span>
            <PlanNumber value={d.battery} unit="kW" signed />
          </li>
        </ul>
      </div>
      <div className="agent-evidence-row">
        <section className="agent-chain" aria-label="决策链">
          <h3>决策链</h3>
          <ol className="agent-steps">
            {(manual
              ? [
                  {
                    name: "人工接管",
                    tool: "takeover",
                    summary: `${manual.operator_id} · 自动下发已停止`,
                    blocked: true,
                  },
                ]
              : steps
            ).map((s) => (
              <li key={s.name} title={s.tool} tabIndex={0}>
                <b>{s.name}</b>
                <span className="agent-step-result">{s.summary}</span>
                <small className="agent-step-time">
                  {s.blocked
                    ? ""
                    : s.time === undefined || s.time === null
                      ? ""
                      : elapsedMs(s.time)}
                </small>
              </li>
            ))}
          </ol>
        </section>
        <section className="agent-comparison" aria-label="候选方案对比">
          <header>
            <h3>候选方案对比</h3>
            <small>{costWindowLabel(d)}</small>
          </header>
          {manual ? (
            <p>人工配置生效中，自动候选不用于当前下发。</p>
          ) : d.handoff ? (
            <div className="agent-handoff-summary">
              <b>预测不确定性过高</b>
              <p>
                风险评分 {pct(hour.risk_score)} · 阈值{" "}
                {pct(hour.risk_threshold)}
              </p>
              <p>
                区间 {n(hour.lower_kw)} – {n(hour.upper_kw)} kW
              </p>
              <p>候选评估已暂停，自动下发已停止。</p>
              <button type="button" onClick={() => setRecordsMode("receipt")}>
                查看执行回执
              </button>
              <button type="button" onClick={() => void requestTicket()}>
                查看人工工单
              </button>
            </div>
          ) : (
            <div
              className="agent-table-scroll"
              role="region"
              aria-label="候选方案表"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    {[
                      "方案",
                      "储能 / kW",
                      "预计电费 / 元",
                      "预计峰值 / kW",
                      "是否通过",
                    ].map((h) => (
                      <th scope="col" key={h}>
                        {h.split(" / ")[0]}
                        {h.includes(" / ") && (
                          <small>{h.split(" / ")[1]}</small>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.candidates.map((c) => (
                    <tr
                      key={c.id}
                      className={c.id === d.selected ? "agent-selected" : ""}
                      aria-selected={c.id === d.selected}
                    >
                      <th scope="row">{c.name}</th>
                      <td className="agent-candidate-storage">
                        <AnimatedValue text={storageLabel(c.battery)} />
                      </td>
                      <td>
                        <AnimatedValue
                          text={c.cost === null ? "暂无数据" : n(c.cost)}
                        />
                      </td>
                      <td title={c.peakBasis ?? "点负荷"}>
                        <AnimatedValue
                          text={c.peak === null ? "暂无数据" : n(c.peak)}
                        />
                      </td>
                      <td>
                        <span
                          className={`agent-record-state ${c.passed ? "agent-green" : "agent-red"}`}
                        >
                          {c.passed === null
                            ? "暂无数据"
                            : c.passed
                              ? "通过"
                              : "不通过"}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!d.candidates.length && (
                    <tr>
                      <td colSpan={5}>暂无数据</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {wide && actions}
        </section>
      </div>
      <section className="agent-reason-section" aria-label="调度理由">
        <h3>调度理由</h3>
        <PlanReason key={d.t} reason={show(decisionReasonLabel(d))} />
      </section>
      {!wide && actions}
      {recordsMode && (
        <ServiceRecordsDialog
          key={`${date}|${index}|${recordsMode}`}
          date={date}
          hour={index}
          initial={recordsMode}
          connected={takeover.connected}
          onClose={() => setRecordsMode(null)}
        />
      )}
      <dialog
        ref={ticket}
        className="agent-reason-dialog"
        aria-label="人工工单"
      >
        <header>
          <h3>
            人工工单 ·{" "}
            {detailState?.origin === summary.t &&
            (detailState.loading || detailState.error)
              ? "暂无数据"
              : show(d.ticket.id)}
          </h3>
          <button type="button" onClick={() => ticket.current?.close()}>
            关闭
          </button>
        </header>
        {detailState?.origin === summary.t && detailState.loading ? (
          <p role="status">明细加载中…</p>
        ) : detailState?.origin === summary.t && detailState.error ? (
          <div role="alert">
            <p>数据暂不可用</p>
            <button type="button" onClick={() => void requestTicket()}>
              重试
            </button>
          </div>
        ) : (
          <section className="agent-ticket">
            <h4>可能原因</h4>
            <ul>
              {d.ticket.reasons.map((r) => (
                <li key={r}>{show(r)}</li>
              ))}
            </ul>
            <h4>建议检查</h4>
            <ul>
              {d.ticket.checks.map((r) => (
                <li key={r}>{show(r)}</li>
              ))}
            </ul>
            <h4>保守默认动作</h4>
            <p>
              温控 {n(d.ticket.temp)} °C · 储能 {storagePower(d.ticket.battery)}{" "}
              · 暂停自动下发
            </p>
          </section>
        )}
      </dialog>
    </Card>
  );
}
