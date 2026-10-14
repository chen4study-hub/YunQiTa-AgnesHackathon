import { useEffect, useRef, useState } from "react";
import {
  takeoverRequest,
  readRecommendation,
  readTakeover,
  buildTakeoverInput,
  prefillTakeoverFields,
  TakeoverError,
  type Recommendation,
  type Takeover,
  type TakeoverFields,
  takeoverIsActive,
  rememberedOperator,
  rememberOperator,
  takeoverInterval,
  recordEventTime,
  readHourCancellation,
  latestHourCancellation,
  type CancelledTakeover,
} from "./takeover-api";
import "./takeover.css";
import { formatPageNumber } from "../displayNumbers";
export const modeName = { idle: "待机", charge: "充电", discharge: "放电" };
const empty: TakeoverFields = {
  duration: "",
  temp: "",
  mode: "",
  power: "",
  reason: "",
  operator: "",
};
export function useTakeover(date: string, hour: number) {
  const scope = `${date}|${hour}`;
  const [state, setState] = useState<{
    scope: string;
    connected: boolean;
    record: Takeover | null;
    cancelled: CancelledTakeover | null;
  }>({ scope, connected: false, record: null, cancelled: null });
  const [error, setError] = useState("");
  const epoch = useRef(0),
    liveScope = useRef(scope),
    blocked = useRef(false);
  liveScope.current = scope;
  useEffect(() => {
    const controller = new AbortController();
    let running = false;
    blocked.current = false;
    ++epoch.current;
    setState({ scope, connected: false, record: null, cancelled: null });
    setError("");
    const refresh = async () => {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      const revision = epoch.current;
      try {
        const result = await takeoverRequest(
          `/takeover/active?date=${encodeURIComponent(date)}&hour=${hour}`,
          undefined,
          controller.signal,
        );
        const record = readTakeover(result.takeover);
        let cancelled: CancelledTakeover | null | undefined;
        try {
          cancelled = await readHourCancellation(date, hour, controller.signal);
        } catch {
          /* Active-state reads remain usable when history is temporarily unavailable. */
        }
        if (!controller.signal.aborted && revision === epoch.current)
          setState((s) => ({
            scope,
            connected: !blocked.current,
            record: takeoverIsActive(record, date, hour) ? record : null,
            cancelled: cancelled === undefined ? s.cancelled : cancelled,
          }));
      } catch (e) {
        if (!controller.signal.aborted && revision === epoch.current) {
          setState((s) => ({ ...s, scope, connected: false }));
          setError(
            e instanceof Error ? e.message : "接管服务暂不可用，请稍后重试",
          );
        }
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000),
      focus = () => void refresh();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [date, hour, scope]);
  const inScope = state.scope === scope;
  return {
    connected: inScope && state.connected,
    record: inScope ? state.record : null,
    cancelled: inScope ? state.cancelled : null,
    setCancellation: (cancelled: CancelledTakeover | null) => {
      if (liveScope.current !== scope) return;
      ++epoch.current;
      setState((s) => ({ ...s, cancelled }));
    },
    error,
    setError,
    setRecord: (record: Takeover | null) => {
      if (liveScope.current !== scope) return;
      ++epoch.current;
      setState((s) => ({
        ...s,
        scope,
        connected: true,
        record: takeoverIsActive(record, date, hour) ? record : null,
      }));
    },
    disconnect: () => {
      if (liveScope.current !== scope) return;
      blocked.current = true;
      setState((s) => ({ ...s, scope, connected: false }));
    },
  };
}
export type TakeoverState = ReturnType<typeof useTakeover>;
export function TakeoverPanel({
  date,
  hour,
  state,
  dialog,
  onChanged,
}: {
  date: string;
  hour: number;
  state: TakeoverState;
  dialog: React.RefObject<HTMLDialogElement | null>;
  onChanged?: (change: "created" | "cancelled") => void | Promise<void>;
}) {
  const [start, setStart] = useState(hour),
    [fields, setFields] = useState<TakeoverFields>(() => ({
      ...empty,
      operator: rememberedOperator(),
    })),
    [rec, setRec] = useState<Recommendation | null>(null),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [cancelOpen, setCancelOpen] = useState(false),
    [cancelReason, setCancelReason] = useState("");
  const touched = useRef<Partial<Record<keyof TakeoverFields, boolean>>>({});
  const submission = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    touched.current = {};
    setStart(hour);
    setFields({ ...empty, operator: rememberedOperator() });
    setCancelOpen(false);
    submission.current = null;
    dialog.current?.close();
  }, [date, hour, dialog]);
  useEffect(() => {
    const controller = new AbortController();
    setRec(null);
    setLoading(true);
    void takeoverRequest(
      `/takeover/recommendation?date=${encodeURIComponent(date)}&hour=${start}`,
      undefined,
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) {
          const recommendation = readRecommendation(r);
          setRec(recommendation);
          setFields((fields) =>
            prefillTakeoverFields(fields, recommendation, touched.current),
          );
          state.setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          state.setError(
            e instanceof Error ? e.message : "接管服务暂不可用，请稍后重试",
          );
          if (e instanceof TakeoverError && e.disconnected) state.disconnect();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [date, start]);
  const change = (name: keyof TakeoverFields, value: string) => {
    touched.current[name] = true;
    if (name === "operator") rememberOperator(value);
    setFields((f) => ({ ...f, [name]: value }));
  };
  const mode = fields.mode || (rec?.available ? rec.storage_mode : undefined);
  const placeholder = (
    name: "duration_hours" | "hvac_setpoint_c" | "storage_power_kw",
  ) =>
    rec?.available && rec[name] !== undefined
      ? formatPageNumber(
          rec[name]!,
          name === "duration_hours" ? "integer" : "decimal",
          false,
        )
      : "";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !state.connected || loading) return;
    state.setError("");
    setSaving(true);
    try {
      const provisional = buildTakeoverInput(
          date,
          start,
          fields,
          rec,
          "pending",
        ),
        signature = JSON.stringify({ ...provisional, request_id: undefined });
      if (submission.current?.signature !== signature)
        submission.current = { signature, id: crypto.randomUUID() };
      const body = { ...provisional, request_id: submission.current.id },
        result = await takeoverRequest("/takeover", body),
        record = readTakeover(result.takeover);
      if (!record)
        throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
      state.setRecord(record);
      dialog.current?.close();
      await onChanged?.("created");
    } catch (e) {
      state.setError(e instanceof Error ? e.message : "接管请求失败");
      if (e instanceof TakeoverError && e.disconnected) state.disconnect();
    } finally {
      setSaving(false);
    }
  }
  async function cancel(e: React.FormEvent) {
    e.preventDefault();
    if (!state.record || saving || !state.connected) return;
    setSaving(true);
    state.setError("");
    try {
      const result = await takeoverRequest(
        `/takeover/${encodeURIComponent(state.record.id)}/cancel`,
        {
          operator_id: fields.operator.trim() || state.record.operator_id,
          reason: cancelReason.trim(),
          expected_version: state.record.version,
        },
      );
      if (!readTakeover(result.takeover))
        throw new TakeoverError("接管服务暂不可用，请稍后重试", true);
      // Persisted cancellation is visible immediately; schedule remains authoritative.
      state.setRecord(null);
      state.setCancellation(
        latestHourCancellation([result.takeover], date, hour),
      );
      setCancelOpen(false);
      await onChanged?.("cancelled");
      const active = await takeoverRequest(
        `/takeover/active?date=${encodeURIComponent(date)}&hour=${hour}`,
      );
      state.setRecord(readTakeover(active.takeover));
      setCancelOpen(false);
      try {
        state.setCancellation(await readHourCancellation(date, hour));
      } catch {
        state.setError("撤销已完成，接管历史暂不可用，请稍后重试");
      }
    } catch (e) {
      state.setError(e instanceof Error ? e.message : "撤销失败");
      if (e instanceof TakeoverError && e.disconnected) state.disconnect();
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      {state.cancelled &&
      (!state.record || state.record.id === state.cancelled.id) ? (
        <section
          className="agent-takeover-banner agent-takeover-cancelled"
          role="status"
        >
          本小时人工接管已撤销 ·{" "}
          {recordEventTime(state.cancelled.cancelled_at, date)} · 操作人{" "}
          {state.cancelled.operator_id}
        </section>
      ) : (
        state.record && (
          <section className="agent-takeover-banner" role="status">
            <b>人工接管中</b>
            <span aria-hidden="true">·</span>
            <span>
              {takeoverInterval(
                state.record.start_at,
                state.record.end_at,
                date,
              )}{" "}
              · 操作人 {state.record.operator_id}
            </span>
            <span>
              · 温控 {state.record.hvac_setpoint_c.toFixed(1)} °C · 储能{" "}
              {modeName[state.record.storage_mode]}
              {state.record.storage_mode === "idle"
                ? ""
                : ` ${state.record.storage_power_kw.toFixed(1)} kW`}
            </span>
            <button
              type="button"
              disabled={!state.connected || saving}
              onClick={() => setCancelOpen(!cancelOpen)}
            >
              撤销接管
            </button>
          </section>
        )
      )}
      {state.error && state.error !== "接管服务暂不可用，请稍后重试" && (
        <p role="alert" className="agent-takeover-error">
          {state.error}
        </p>
      )}
      {cancelOpen && (
        <form
          className="agent-takeover-cancel"
          onSubmit={(e) => void cancel(e)}
        >
          <label>
            撤销原因
            <input
              aria-label="撤销原因"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              required
              maxLength={2000}
            />
          </label>
          <label>
            撤销操作人
            <input
              value={fields.operator}
              aria-label="撤销操作人"
              placeholder={state.record?.operator_id}
              onChange={(e) => change("operator", e.target.value)}
            />
          </label>
          <button disabled={!state.connected || saving || !cancelReason.trim()}>
            确认撤销
          </button>
        </form>
      )}
      <dialog
        ref={dialog}
        className="agent-takeover-dialog"
        aria-label="人工接管配置"
      >
        <header>
          <h3 className="type-title">人工接管</h3>
          <button type="button" onClick={() => dialog.current?.close()}>
            关闭
          </button>
        </header>
        <p>{date} · 未填写的配置使用当前推荐，提交后由人工配置接管。</p>
        {loading ? (
          <p role="status">推荐加载中…</p>
        ) : rec && !rec.available ? (
          <p role="status">{rec.message ?? "推荐暂不可用"}</p>
        ) : null}
        {state.error && state.error !== "接管服务暂不可用，请稍后重试" && (
          <p role="alert" className="agent-takeover-error">
            {state.error}
          </p>
        )}
        <form onSubmit={(e) => void submit(e)} className="agent-takeover-form">
          <label>
            开始小时
            <select
              value={start}
              onChange={(e) => {
                touched.current = {};
                setStart(Number(e.target.value));
                setFields({ ...empty, operator: rememberedOperator() });
              }}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {String(i).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
          <label>
            持续小时
            <input
              type="number"
              min={1}
              max={24}
              step={1}
              value={fields.duration}
              placeholder={
                rec?.available ? `推荐 ${placeholder("duration_hours")}` : ""
              }
              onChange={(e) => change("duration", e.target.value)}
            />
          </label>
          <label>
            设定温度（°C）
            <input
              type="number"
              min={24}
              max={27}
              step={0.1}
              value={fields.temp}
              placeholder={
                rec?.available ? `推荐 ${placeholder("hvac_setpoint_c")}` : ""
              }
              onChange={(e) => change("temp", e.target.value)}
            />
          </label>
          <label>
            储能模式
            <select
              value={fields.mode}
              onChange={(e) => change("mode", e.target.value)}
            >
              <option value="">
                {rec?.available && rec.storage_mode
                  ? `推荐：${modeName[rec.storage_mode]}`
                  : "请选择"}
              </option>
              <option value="idle">待机</option>
              <option value="charge">充电</option>
              <option value="discharge">放电</option>
            </select>
          </label>
          <label>
            储能功率（kW）
            {mode === "idle" ? (
              <span className="agent-takeover-idle">待机，不下发功率</span>
            ) : mode === "charge" || mode === "discharge" ? (
              <input
                type="number"
                min={0}
                max={500}
                step={0.1}
                value={fields.power}
                placeholder={
                  rec?.available
                    ? `推荐 ${placeholder("storage_power_kw")}`
                    : ""
                }
                onChange={(e) => change("power", e.target.value)}
              />
            ) : (
              <span>请选择储能模式</span>
            )}
          </label>
          <label>
            原因
            <textarea
              value={fields.reason}
              placeholder={rec?.available ? rec.reason : ""}
              onChange={(e) => change("reason", e.target.value)}
              maxLength={2000}
            />
          </label>
          <label>
            操作人
            <input
              value={fields.operator}
              onChange={(e) => change("operator", e.target.value)}
              maxLength={100}
              required
              placeholder="请输入操作人"
            />
          </label>
          <button
            type="submit"
            disabled={saving || loading || !state.connected}
          >
            {saving ? "正在提交…" : "提交接管"}
          </button>
        </form>
      </dialog>
    </>
  );
}
