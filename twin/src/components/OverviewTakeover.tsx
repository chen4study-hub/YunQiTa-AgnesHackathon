import type { Takeover } from "../pages/agent/takeover-api";
import { formatNumber } from "../ui/numberFormat";
import { formatLocalMinute } from "../config/displayTime";
import { OverviewStatusText } from './OverviewStatusText';

export function OverviewTakeover({
  record,
  nowMs,
}: {
  record: Takeover;
  nowMs: number;
}) {
  if (record.record_status === "cancelled") {
    const cancelledAt =
      typeof record.cancelled_ms === "number" &&
      Number.isFinite(record.cancelled_ms)
        ? formatLocalMinute(record.cancelled_ms)
        : "未记录";
    return (
      <small className="overview-takeover-cancelled" role="status">
        <OverviewStatusText text="本小时人工接管已撤销" /> · 撤销时间 {cancelledAt} · 操作人{" "}
        {record.operator_id}
      </small>
    );
  }
  if (record.record_status !== "active") return null;
  const remaining = Math.max(0, Math.ceil((record.end_ms - nowMs) / 3600000));
  const mode = { idle: "待机", charge: "充电", discharge: "放电" }[
    record.storage_mode
  ];
  return (
    <section
      className="overview-takeover"
      role="status"
      aria-label="人工接管状态"
    >
      <div className="dispatch-banner handoff-banner">
        <b>
          <OverviewStatusText text="人工接管中" /> · 操作人 {record.operator_id} · 剩余 {remaining} 小时
        </b>
      </div>
      <p>人工设定温度 <OverviewStatusText text={`${formatNumber(record.hvac_setpoint_c, 1)} °C`} /></p>
      <p>
        储能 <OverviewStatusText text={mode} />
        {record.storage_mode === "idle"
          ? ""
          : <> <OverviewStatusText text={`${formatNumber(record.storage_power_kw, 1)} kW`} /></>}
      </p>
    </section>
  );
}
