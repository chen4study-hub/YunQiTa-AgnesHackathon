import { useEffect, useMemo, useRef } from "react";
import { Card } from "../components/Card";
import { SmoothChart as EChart } from "./energy/SmoothChart";
import { useOpsPage } from "./energy/useOpsPage";
import { opsTimeLabel, energyCurrentTime, opsDateTime } from "./energy/time";
import { formatDisplayDate } from "../config/presentation";
import {
  cumulativeUses,
  endUseRows,
  energyAlerts,
  windowAlerts,
  energyNumber,
  environmentAt,
} from "./energy/data";
import { emsChart, endUseChart, environmentChart } from "./energy/charts";
import { PowerOverview } from "./energy/PowerOverview";
import { AlertTableViewport } from "./energy/AlertTableViewport";
import "./energy/energy.css";

export function EnergyPage() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const main = root.current?.closest("main");
    if (!main) return;
    // The shell hides overflow by default. Opt in only while this page is mounted,
    // without editing shared shell files or leaving a style on the next page.
    const properties = ["overflow-y", "overflow-x"] as const;
    const previous = properties.map((property) => ({
      property,
      value: main.style.getPropertyValue(property),
      priority: main.style.getPropertyPriority(property),
    }));
    main.style.setProperty("overflow-y", "auto", "important");
    main.style.setProperty("overflow-x", "hidden", "important");
    return () => {
      for (const { property, value, priority } of previous) {
        const ownedValue = property === "overflow-y" ? "auto" : "hidden";
        if (
          main.style.getPropertyValue(property) !== ownedValue ||
          main.style.getPropertyPriority(property) !== "important"
        )
          continue;
        if (value) main.style.setProperty(property, value, priority);
        else main.style.removeProperty(property);
      }
    };
  }, []);
  const { day, snapshot, atMs, chartData, loading, error, retry } =
    useOpsPage();
  const displayDate = formatDisplayDate(atMs);
  const displayMs = Math.floor(atMs / 1000) * 1000;
  const displayTime = energyCurrentTime(displayMs);
  const hour = snapshot?.hour;
  const view = useMemo(
    () =>
      day && hour && chartData
        ? {
            environment: environmentAt(hour),
            totals: cumulativeUses(hour.energy.cumulative_start_kwh),
            alerts:
              "days" in chartData
                ? windowAlerts(chartData, atMs)
                : energyAlerts(day, atMs),
            uses: endUseRows(hour),
            donut: endUseChart(hour),
            ems: emsChart(chartData, displayTime, atMs),
            environmentChart: environmentChart(chartData, displayTime, atMs),
          }
        : null,
    [day, hour, chartData, displayMs, displayTime],
  );
  if (!view || !day || !hour)
    return (
      <div ref={root} className="energy-page" data-date={displayDate}>
        <Card label="能源与告警">
          <h2 className="type-title">能源与告警</h2>
          <p role="status">
            {error
              ? "数据暂不可用"
              : loading
                ? "正在加载能源数据…"
                : "数据暂不可用"}
          </p>
          {error && <button onClick={retry}>重试</button>}
        </Card>
      </div>
    );
  const environment = view.environment;
  const currentTimeLabel = opsTimeLabel(atMs, atMs);
  const visibleAlerts = view.alerts;
  return (
    <div
      ref={root}
      className="energy-page"
      data-scroll-region="energy-page"
      data-time={displayTime}
      data-ops-at-ms={atMs}
      data-date={displayDate}
    >
      <Card className="energy-end-use" label="分项能耗">
        <div className="energy-heading">
          <div>
            <h2 className="type-title">分项能耗</h2>
            <small>当前负荷 · {currentTimeLabel}</small>
          </div>
          <span className="energy-tag">分项计量</span>
        </div>
        <div className="energy-breakdown">
          <div className="energy-donut">
            <EChart
              option={view.donut}
              label="分项能耗环形图"
              className="energy-donut-chart"
            />
            <div className="energy-donut-total">
              <span>总负荷</span>
              <b className="type-number" data-unit="kW">
                <span className="energy-number">
                  {energyNumber(hour.actual_kw, 1)}
                </span>
                <small className="type-unit">{"\u00a0"}kW</small>
              </b>
            </div>
          </div>
          <ul className="energy-use-legend">
            {view.uses.map((item) => (
              <li key={item.name}>
                <span>
                  <i style={{ background: item.color }} />
                  {item.name}
                </span>
                <b>
                  <span className="energy-number">
                    {energyNumber(item.value, 1)}
                  </span>
                  {"\u00a0"}
                  kW
                </b>
              </li>
            ))}
          </ul>
        </div>
        <div className="energy-section-heading">
          <h3>今日累计</h3>
          <small>截至本小时开始</small>
        </div>
        <div className="energy-cumulative">
          {view.totals.map((item) => (
            <div key={item.name}>
              <span>{item.name}</span>
              <b className="type-number">
                <span className="energy-number">
                  {energyNumber(item.energy, 1)}
                </span>
                <small className="type-unit">{"\u00a0"}kWh</small>
              </b>
            </div>
          ))}
        </div>
      </Card>
      <Card className="energy-ems" label="储能与光伏">
        <div className="energy-heading">
          <div>
            <h2 className="type-title">储能与光伏</h2>
            <small>充放电与光伏出力 · 24 小时</small>
            <time className="energy-cursor-time" dateTime={opsDateTime(atMs)}>
              当前 {currentTimeLabel}
            </time>
          </div>
          <span className="energy-tag">EMS</span>
        </div>
        <div className="energy-ems-top">
          <PowerOverview data={day} hour={hour} />
        </div>
        <div className="energy-chart-slot">
          <EChart
            option={view.ems}
            label="储能正放电负充电与光伏双轴图"
            className="energy-timeseries"
          />
        </div>
        <div className="energy-ems-totals">
          <div>
            <span>本小时用电</span>
            <b className="type-number">
              <span className="energy-number">
                {energyNumber(hour.energy.hour_kwh.actual_kwh, 1)}
              </span>
              <small className="type-unit">{"\u00a0"}kWh</small>
            </b>
          </div>
          <div>
            <span>今日累计（截至本小时开始）</span>
            <b className="type-number">
              <span className="energy-number">
                {energyNumber(hour.energy.cumulative_start_kwh.actual_kwh, 1)}
              </span>
              <small className="type-unit">{"\u00a0"}kWh</small>
            </b>
          </div>
          <div>
            <span>本小时费用</span>
            <b className="type-number">
              <span className="energy-number">
                {energyNumber(hour.energy.hour_cost_cny, 1)}
              </span>
              <small className="type-unit">{"\u00a0"}元</small>
            </b>
          </div>
        </div>
      </Card>
      <Card className="energy-environment" label="环境与人员">
        <div className="energy-heading">
          <div>
            <h2 className="type-title">环境与人员</h2>
            <small>环境参考与在楼人数</small>
          </div>
          <span className="energy-tag">IoT 传感</span>
        </div>
        <div className="energy-environment-metrics">
          {[
            ["室内温度", energyNumber(environment.indoor_temp_c, 1), "℃"],
            ["相对湿度", energyNumber(environment.relative_humidity_pct), "%"],
            ["平均 CO₂", energyNumber(environment.co2_ppm), "ppm"],
            ["PM2.5", energyNumber(environment.pm25_ug_m3), "μg/m³"],
            ["在楼人数", energyNumber(environment.people), "人"],
            [
              "室外温度",
              environment.outdoor_temp_c === null
                ? "—"
                : energyNumber(environment.outdoor_temp_c, 1),
              "℃",
            ],
          ].map(([label, value, unit]) => (
            <div key={label}>
              <span>{label}</span>
              <b
                className="type-number"
                data-unit={unit}
                style={
                  label === "平均 CO₂" && environment.co2_ppm >= 1000
                    ? { color: "#ff4d5e" }
                    : undefined
                }
              >
                <span className="energy-number">{value}</span>
                <small className="type-unit">
                  {unit === "%" ? null : "\u00a0"}
                  {unit}
                </small>
              </b>
            </div>
          ))}
        </div>
        <div className="energy-chart-slot">
          <EChart
            option={view.environmentChart}
            label="人数与CO₂双轴图，1000 ppm红色点线"
            className="energy-timeseries"
          />
        </div>
      </Card>
      <Card className="energy-alerts" label="告警中心">
        <div className="energy-heading">
          <div>
            <h2 className="type-title">告警与工单</h2>
            <small>
              <time dateTime={opsDateTime(atMs)}>
                {displayDate} · {currentTimeLabel}
              </time>{" "}
              / 工单优先
            </small>
          </div>
          <span className="energy-tag">BMS 告警</span>
        </div>
        <div className="energy-alerts-summary">
          <span>
            <i className="energy-dot energy-red" />
            {energyNumber(
              view.alerts.filter((alert) => alert.agent).length,
            )}{" "}
            条工单
          </span>
          <span>
            {energyNumber(
              view.alerts.filter(
                (alert) => !alert.agent && alert.level === "关注",
              ).length,
            )}{" "}
            条环境 / 设备关注
          </span>
          <small>仅显示截至当前时刻的记录</small>
        </div>
        <AlertTableViewport>
          <table className="energy-alert-table">
            <thead>
              <tr>
                {["级别", "时间", "系统", "内容", "处理建议", "状态"].map(
                  (label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {visibleAlerts.length === 0 && (
                <tr>
                  <td colSpan={6}>暂无告警与工单</td>
                </tr>
              )}
              {visibleAlerts.map((alert) => (
                <tr
                  key={alert.key}
                  data-alert-id={alert.id}
                  data-agent={alert.agent}
                  className={
                    alert.agent ? "energy-agent-order" : "energy-monitor-alert"
                  }
                >
                  <td>
                    <span
                      className={`energy-level ${alert.agent ? "energy-level-red" : alert.level === "关注" ? "energy-level-yellow" : "energy-level-green"}`}
                    >
                      {alert.level}
                    </span>
                  </td>
                  <td>
                    <time
                      dateTime={alert.dateTime}
                      title={alert.dateTime.replace("T", " ")}
                    >
                      {alert.time}
                    </time>
                  </td>
                  <th scope="row">{alert.system}</th>
                  <td title={alert.content}>
                    <b>{alert.content}</b>
                    {alert.agent && (
                      <small className="energy-order-id">{alert.id}</small>
                    )}
                  </td>
                  <td title={alert.action}>{alert.action}</td>
                  <td>{alert.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AlertTableViewport>
      </Card>
    </div>
  );
}
