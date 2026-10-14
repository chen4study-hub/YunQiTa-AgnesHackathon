import { useEffect, useRef, useState } from "react";
import {
  takeoverRequest,
  TakeoverError,
  readServiceReceipt,
  controlSummary,
  auditActions,
  rememberedOperator,
  rememberOperator,
  takeoverInterval,
  recordEventTime,
  sortTakeoverHistory,
  type ServiceReceipt,
  type HistoryRow,
  type AuditRow,
} from "./takeover-api";
import { storagePower } from "./data";
import { formatPageNumber } from "../displayNumbers";
export type RecordsMode = "receipt" | "history" | "audit";
const names = { receipt: "执行回执", history: "接管历史", audit: "操作日志" };
export function ServiceRecordsDialog({
  date,
  hour,
  initial,
  connected = true,
  onClose,
}: {
  date: string;
  hour: number;
  initial: RecordsMode;
  connected?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [mode, setMode] = useState(initial),
    [who, setWho] = useState(() => rememberedOperator()),
    [needsOperator, setNeedsOperator] = useState(
      () => !rememberedOperator().trim(),
    ),
    [receipt, setReceipt] = useState<ServiceReceipt | null>(null),
    [history, setHistory] = useState<HistoryRow[]>([]),
    [audits, setAudits] = useState<AuditRow[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => requestRef.current?.abort();
  }, []);
  useEffect(() => {
    if (mode === "receipt" && !connected) {
      requestRef.current?.abort();
      setReceipt(null);
      setError("");
      setLoading(false);
      return;
    }
    if (mode !== "receipt" || who.trim()) void load();
    else {
      setReceipt(null);
      setError("");
    }
  }, [mode, date, hour, revision, connected]);
  async function load() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (mode === "receipt" && !who.trim()) {
      setError("请输入操作人后查询执行回执");
      return;
    }
    setLoading(true);
    setError("");
    setReceipt(null);
    try {
      const path =
        mode === "receipt"
          ? `/dispatch/receipt?date=${encodeURIComponent(date)}&hour=${hour}&operator_id=${encodeURIComponent(who.trim())}`
          : mode === "history"
            ? `/takeover/history?date=${encodeURIComponent(date)}`
            : `/audit?date=${encodeURIComponent(date)}`;
      const result = await takeoverRequest(path, undefined, controller.signal);
      if (controller.signal.aborted) return;
      if (mode === "receipt") setReceipt(readServiceReceipt(result));
      else {
        if (!Array.isArray(result.items)) throw new Error("数据暂不可用");
        if (mode === "history")
          setHistory(
            sortTakeoverHistory(
              result.items.filter(
                (r): r is HistoryRow =>
                  !!r &&
                  typeof r === "object" &&
                  typeof r.id === "string" &&
                  typeof r.start_at === "string" &&
                  typeof r.end_at === "string",
              ),
            ),
          );
        else
          setAudits(
            result.items.filter(
              (r): r is AuditRow =>
                !!r &&
                typeof r === "object" &&
                typeof r.occurred_at === "string",
            ),
          );
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          mode === "receipt" && e instanceof TakeoverError && e.disconnected
            ? "需要连接后端"
            : e instanceof Error
              ? e.message
              : "数据暂不可用",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="agent-takeover-dialog agent-service-records"
      aria-label={mode === "receipt" ? "执行回执" : "接管记录与日志"}
      onCancel={onClose}
    >
      <header>
        <h3 className="type-title">{names[mode]}</h3>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </header>
      <p>
        {date}
        {mode === "receipt" ? ` · ${String(hour).padStart(2, "0")}:00` : ""}
      </p>
      {initial !== "receipt" && (
        <div role="tablist" aria-label="记录类型">
          {(["history", "audit"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => {
                requestRef.current?.abort();
                setMode(m);
              }}
            >
              {names[m]}
            </button>
          ))}
        </div>
      )}
      {mode === "receipt" && connected && needsOperator && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (who.trim()) {
              rememberOperator(who.trim());
              setNeedsOperator(false);
              void load();
            }
          }}
        >
          <label>
            操作人
            <input
              value={who}
              onChange={(e) => {
                setWho(e.target.value);
              }}
              maxLength={100}
              placeholder="请输入操作人"
              required
            />
          </label>
          <button disabled={loading || !who.trim()}>查询回执</button>
        </form>
      )}
      {mode === "receipt" && !connected ? (
        <p role="status" className="agent-receipt-offline">
          需要连接后端
        </p>
      ) : loading ? (
        <p role="status">数据加载中…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : mode === "receipt" ? (
        receipt && (
          <section className="agent-server-receipt">
            <b>{receipt.source === "manual" ? "人工指令" : "Agent 指令"}</b>
            <p>指令已写入调度记录</p>
            <p>
              {receipt.count === null
                ? "条数暂无数据"
                : `${formatPageNumber(receipt.count, "integer")} 条指令`}{" "}
            </p>
            {receipt.source === "agent" &&
              receipt.actions.length > 0 &&
              receipt.records.length === 0 && (
                <ul>
                  {receipt.actions.map((a, i) => (
                    <li key={i}>
                      <span className="agent-record-written">
                        {recordEventTime(receipt.written_at, date)} 写入 ·{" "}
                      </span>
                      {a}
                    </li>
                  ))}
                </ul>
              )}
            {receipt.records.length > 0 ? (
              <ul>
                {receipt.records.map((r, i) => (
                  <li
                    key={i}
                    className={
                      r.effective === false
                        ? "agent-receipt-inactive"
                        : undefined
                    }
                    data-effective={
                      r.effective === undefined
                        ? "unknown"
                        : String(r.effective)
                    }
                  >
                    <span className="agent-record-written">
                      {recordEventTime(r.created_at, date)} 写入 ·{" "}
                    </span>
                    {r.destination === "BA"
                      ? `BA：设定 ${formatPageNumber(r.command.setpoint_c!, "decimal")} °C`
                      : `EMS：${storagePower(r.command.battery_kw!)}`}{" "}
                    ·{" "}
                    {r.effective === false
                      ? "已失效的历史指令"
                      : r.effective === true
                        ? "当前小时有效"
                        : "有效性暂无数据"}
                  </li>
                ))}
              </ul>
            ) : receipt.actions.length === 0 ? (
              <p>暂无数据</p>
            ) : null}
          </section>
        )
      ) : mode === "history" ? (
        <section aria-label="接管历史记录">
          {history.length ? (
            history.map((r) => (
              <article key={r.id}>
                <b>{takeoverInterval(r.start_at, r.end_at, date)}</b>
                <p>
                  {r.operator_id} ·{" "}
                  {(
                    {
                      active: "接管中",
                      cancelled: "已撤销",
                      expired: "已到期",
                      manual: "人工接管",
                    } as Record<string, string>
                  )[r.status] ?? "状态暂无数据"}
                </p>
                <p>{controlSummary(r)}</p>
                <p className="agent-record-event-times">
                  建立：{recordEventTime(r.created_at, date)} · 撤销：
                  {r.cancelled_at
                    ? recordEventTime(r.cancelled_at, date)
                    : r.status === "cancelled"
                      ? "时间暂无数据"
                      : "未撤销"}
                </p>
              </article>
            ))
          ) : (
            <p>暂无数据</p>
          )}
        </section>
      ) : (
        <section aria-label="操作日志记录">
          {audits.length ? (
            audits.map((r, i) => (
              <article key={r.id ?? i}>
                <b>
                  {r.occurred_at} · {auditActions[r.action] ?? "其他操作"}
                </b>
                <p>{r.operator_id}</p>
                <p>操作前：{controlSummary(r.before)}</p>
                <p>操作后：{controlSummary(r.after)}</p>
              </article>
            ))
          ) : (
            <p>暂无数据</p>
          )}
        </section>
      )}
      {mode !== "receipt" && (
        <button
          type="button"
          onClick={() => setRevision((r) => r + 1)}
          disabled={loading}
        >
          刷新
        </button>
      )}
    </dialog>
  );
}
