import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { Card } from "../components/Card";
import { SmoothChart as EChart } from "./energy/SmoothChart";
import { useDashboard } from "../state/context";
import { useOpsPage } from "./energy/useOpsPage";
import { energyCurrentTime, opsTimeLabel } from "./energy/time";
import {
  ELEVATOR_PRESENTATION,
  elevatorOperatingStatus,
  liftFloorBottom,
} from "./floors/elevators";
import { floorUseLabel, temperatureColor, ZONE_COLORS } from "./floors/metrics";
import {
  comfortMargin,
  temperatureAt,
  temperaturePosition,
} from "./floors/thermal";
import { FloorLoadChart, FloorLoadLegend } from "./floors/FloorLoadChart";
import { floorMetrics, zoneLabel } from "./floors/metrics";
import { opsFloorScale, sampleOpsFloorLoads } from "../data/ops";
import { formatDisplayDate } from "../config/presentation";
import { floorsNumber } from "./floors/numbers";
import { chartHours, opsTimeAxis, temperatureAxis } from "./energy/charts";
import { seriesTooltip } from "./energy/tooltips";
import "./floors/floors.css";

export function TemperatureDisplay({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const position = temperaturePosition(value);
  return (
    <div
      className="floors-temperature-display"
      aria-label={`${label} ${floorsNumber(value, 1)} ℃，色带22至28℃，舒适上限27℃`}
    >
      <div
        className="floors-temperature-value type-number"
        style={{ color: temperatureColor(value) }}
      >
        <b>{floorsNumber(value, 1)}</b>
        <small className="type-unit">{"\u00a0"}℃</small>
      </div>
      <div
        className="floors-temperature-band"
        role="meter"
        aria-label={`${label} 室温`}
        aria-valuemin={22}
        aria-valuemax={28}
        aria-valuenow={value}
        aria-valuetext={`${floorsNumber(value, 1)} ℃`}
      >
        <i
          className="floors-temperature-limit"
          title="27 ℃ 舒适上限"
          style={{ left: `${temperaturePosition(27)}%` }}
        />
        <i
          className="floors-temperature-position"
          style={{ left: `${position}%` }}
          title={`当前位置 ${floorsNumber(value, 1)} ℃`}
        />
      </div>
      <div className="floors-temperature-scale">
        <span>22</span>
        <span
          aria-label="27 上限"
          title="27 ℃ 舒适上限"
          style={{ left: `${temperaturePosition(27)}%` }}
        >
          27 上限
        </span>
        <span>28 ℃</span>
      </div>
    </div>
  );
}

export function FloorsPage() {
  const { state, store } = useDashboard();
  const { day, snapshot, atMs, chartData, loading, error, retry } =
    useOpsPage();
  const floor = Math.min(day?.meta.floors ?? 40, state.selectedFloor ?? 22);
  const hour = snapshot?.hour;
  const metrics = useMemo(
    () => (hour ? floorMetrics(hour, floor) : null),
    [hour, floor],
  );
  const time = energyCurrentTime(Math.floor(atMs / 1000) * 1000);
  const loads = useMemo(
    () => (day ? [...sampleOpsFloorLoads(day, atMs)] : []),
    [day, atMs],
  );
  const floorUses = useMemo(
    () =>
      hour
        ? Array.from(
            { length: hour.floors.length },
            (_, index) => floorMetrics(hour, index + 1).use,
          )
        : [],
    [hour],
  );
  const lifts = snapshot?.elevators ?? [];
  const scale = useMemo(() => (day ? opsFloorScale(day) : null), [day]);
  const chart = useMemo<EChartsOption>(
    () => ({
      animation: false,
      color: [...ZONE_COLORS],
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        formatter: (params) => seriesTooltip(params, { default: "℃" }),
      },
      legend: {
        top: 0,
        textStyle: { color: "#a8bac7" },
        itemWidth: 12,
      },
      grid: { left: 44, right: 20, top: 40, bottom: 36 },
      xAxis: chartData
        ? opsTimeAxis(chartData, atMs)
        : { type: "value", min: 0, max: 24 },
      yAxis: {
        type: "value",
        ...temperatureAxis(
          chartData
            ? chartHours(chartData, atMs).flatMap(({ hour }) =>
                floorMetrics(hour, floor).zones.map((zone) => zone.temp_c),
              )
            : [],
        ),
        interval: 1,
        name: "℃",
        splitLine: { lineStyle: { color: "#1c2a36" } },
      },
      series:
        day && metrics && chartData
          ? metrics.zones.map((zone, index) => ({
              name: zoneLabel(zone.id),
              type: "line",
              symbol: "none",
              smooth: true,
              data: chartHours(chartData, atMs).map((row) => [
                row.t,
                temperatureAt(row.hour, floor, zone.id),
              ]),
              lineStyle: { width: 1.6 },
              markLine:
                index === 0
                  ? {
                      silent: true,
                      symbol: "none",
                      label: {
                        color: "#ff4d5e",
                        formatter: "27 ℃ 舒适上限",
                        position: "insideEndTop",
                      },
                      data: [
                        {
                          yAxis: 27,
                          lineStyle: { color: "#ff4d5e", type: "dotted" },
                          label: {
                            color: "#ff4d5e",
                            formatter: "27 ℃ 舒适上限",
                            position: "insideEndTop",
                          },
                        },
                        {
                          xAxis: time,
                          label: { show: false },
                          lineStyle: { color: "#4fd1d9" },
                        },
                      ],
                    }
                  : undefined,
            }))
          : [],
    }),
    [day, chartData, floor, metrics?.zones, time],
  );
  if (!day || !snapshot || !metrics || !scale || !chartData)
    return (
      <div className="floors-page" data-date={formatDisplayDate(atMs)}>
        <Card label="楼层与电梯">
          <h2 className="type-title">楼层与电梯</h2>
          <p role="status">
            {error
              ? "数据暂不可用"
              : loading
                ? "正在加载楼层数据…"
                : "数据暂不可用"}
          </p>
          {error && <button onClick={retry}>重试</button>}
        </Card>
      </div>
    );
  const equipment = metrics.use === "equipment";
  const hottestZone = metrics.zones.reduce((a, b) =>
    a.temp_c > b.temp_c ? a : b,
  );
  const hottest = hottestZone.temp_c;
  const margin = comfortMargin(hottest);
  return (
    <div
      className="floors-page"
      data-scroll-region="floors-page"
      data-time={time}
      data-ops-at-ms={atMs}
      data-date={formatDisplayDate(atMs)}
    >
      <Card className="floors-list-card" label="楼层负荷分布">
        <div className="floors-heading">
          <div>
            <h2 className="type-title">楼层</h2>
            <small>40 层垂直分布 · 点击查看</small>
          </div>
        </div>
        <label className="floors-selector">
          当前楼层
          <select
            aria-label="选择楼层"
            value={floor}
            onChange={(event) => store.selectFloor(Number(event.target.value))}
          >
            {Array.from(
              { length: day.meta.floors },
              (_, index) => index + 1,
            ).map((number) => (
              <option key={number} value={number}>
                {number}F{" "}
                {floorUseLabel(floorMetrics(snapshot.hour, number).use)}
              </option>
            ))}
          </select>
        </label>
        <div
          className="floors-load-scroll"
          role="region"
          aria-label="楼层负荷分布，全部楼层"
          tabIndex={0}
        >
          <FloorLoadChart
            loads={loads}
            scale={scale}
            floorUses={floorUses}
            selected={floor}
            onSelect={(number) => store.selectFloor(number)}
          />
        </div>
        <FloorLoadLegend scale={scale} />
      </Card>
      <Card className="floors-detail-card" label="楼层详情">
        <div className="floors-heading">
          <div>
            <h2 className="type-title">
              {floor}F {floorUseLabel(metrics.use)}
            </h2>
            <small>
              {equipment ? "设备层运维" : `${metrics.zones.length} 个空间分区`}{" "}
              · {opsTimeLabel(atMs, atMs)}
            </small>
          </div>
          <span className="floors-tag">BA 系统</span>
        </div>
        <div className="floors-zones">
          {metrics.zones.map((zone, index) => (
            <div className="floors-zone" key={zone.id}>
              <h3>
                <i style={{ background: ZONE_COLORS[index] }} />
                {zoneLabel(zone.id)}
              </h3>
              <TemperatureDisplay
                value={zone.temp_c}
                label={zoneLabel(zone.id)}
              />
              <p
                className="floors-zone-setting"
                title={`设定温度 ${floorsNumber(snapshot.hour.hvac_setpoint_c, 1)} ℃；风机 ${Math.round(zone.fan_pct)}%`}
              >
                <span>
                  设定 {floorsNumber(snapshot.hour.hvac_setpoint_c, 1)} ℃
                </span>
                <span>风量 {floorsNumber(zone.fan_pct)}%</span>
              </p>
            </div>
          ))}
        </div>
        <div className="floors-chart-heading">
          <h3>分区室温 · 24 小时</h3>
        </div>
        <EChart
          option={chart}
          label={`${floor}F分区24小时室温曲线，27摄氏度舒适上限`}
          className="floors-temperature-chart"
        />
        <small className="floors-note">
          室温 · 最热 {zoneLabel(hottestZone.id)} {floorsNumber(hottest, 1)} ℃ ·{" "}
          <span className={margin.exceeded ? "floors-over-limit" : undefined}>
            {margin.text}
          </span>
        </small>
      </Card>
      <Card className="floors-metrics-card" label="楼层指标">
        <div className="floors-heading">
          <h2 className="type-title">楼层指标</h2>
          <span className="floors-tag">BA 系统</span>
        </div>
        <div className="floors-metrics">
          {[
            ["楼层负荷", floorsNumber(metrics.floor_actual_kw, 1), "kW"],
            ["在岗人数", floorsNumber(metrics.occupancy_people), "人"],
            ["平均室温", floorsNumber(metrics.mean_temp_c, 1), "℃"],
            ["照明开启", floorsNumber(metrics.lighting_pct), "%"],
            ["新风量", floorsNumber(metrics.fresh_air_m3_h), "m³/h"],
            ["CO₂", floorsNumber(metrics.co2_ppm), "ppm"],
          ].map(([label, value, unit]) => (
            <div key={label}>
              <span>{label}</span>
              <b
                className="type-number"
                data-unit={unit}
                style={
                  label === "平均室温"
                    ? { color: temperatureColor(metrics.mean_temp_c) }
                    : undefined
                }
              >
                <span className="floors-number">{value}</span>
                <small className="type-unit">
                  {unit === "%" ? null : "\u00a0"}
                  {unit}
                </small>
              </b>
            </div>
          ))}
        </div>
      </Card>
      <Card className="floors-elevators-card" label="电梯运行">
        <div className="floors-heading">
          <div>
            <h2 className="type-title">电梯运行</h2>
            <small>低区 L1–L3：1–20F / 高区 H1–H3：1F、21–40F</small>
          </div>
          <span className="floors-tag">梯控接口</span>
        </div>
        <div className="floors-lift-legend">
          {Object.values(ELEVATOR_PRESENTATION).map((item) => (
            <span key={item.label} style={{ color: item.color }}>
              {item.symbol} {item.label}
            </span>
          ))}
        </div>
        <div
          className="floors-lift-scroll"
          role="region"
          aria-label="电梯井道，可横向滚动"
          tabIndex={0}
        >
          <div className="floors-lift-shafts">
            {lifts.map((lift) => {
              const display = ELEVATOR_PRESENTATION[lift.status];
              const config = day.elevators.find((row) => row.id === lift.id)!;
              return (
                <div className="floors-lift-column" key={lift.id}>
                  <h3>
                    {lift.id}
                    <small>{config.zone === "low" ? "低区" : "高区"}</small>
                  </h3>
                  <div
                    className={`floors-lift-shaft floors-${config.zone}`}
                    aria-label={`${lift.id} ${Math.round(lift.floor)}F ${display.label}`}
                    data-floor={lift.floor}
                  >
                    <div
                      className="floors-unserved"
                      aria-label={
                        config.zone === "low"
                          ? "21至40F不停靠"
                          : "2至20F不停靠，仅穿越"
                      }
                      style={
                        config.zone === "low"
                          ? { bottom: liftFloorBottom(21), top: 0 }
                          : {
                              bottom: liftFloorBottom(2),
                              top: `calc(100% - (${liftFloorBottom(21)}))`,
                            }
                      }
                    />
                    {[40, 30, 20, 10, 1].map((level) => (
                      <span
                        className="floors-shaft-tick"
                        key={level}
                        style={{
                          bottom: liftFloorBottom(level),
                        }}
                      >
                        {level}F
                      </span>
                    ))}
                    <div
                      className="floors-lift-car"
                      data-status={lift.status}
                      style={{
                        bottom: liftFloorBottom(lift.floor),
                        color: display.color,
                        borderColor: display.color,
                      }}
                    >
                      <span>{display.symbol}</span>
                      <b>{Math.round(lift.floor)}</b>
                    </div>
                  </div>
                  <span
                    className="floors-lift-floor"
                    style={{ color: display.color }}
                  >
                    {display.symbol} {Math.round(lift.floor)}F
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="floors-lift-scroll floors-lift-table-scroll"
          role="region"
          aria-label="电梯状态表，可横向滚动"
          tabIndex={0}
        >
          <table className="floors-lift-table">
            <caption>电梯运行状态</caption>
            <thead>
              <tr>
                {["电梯", "服务楼层", "当前楼层", "方向", "载重", "状态"].map(
                  (label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {lifts.map((lift) => {
                const display = ELEVATOR_PRESENTATION[lift.status];
                const config = day.elevators.find((row) => row.id === lift.id)!;
                return (
                  <tr key={lift.id}>
                    <th scope="row">{lift.id}</th>
                    <td>{config.zone === "low" ? "1–20F" : "1 / 21–40F"}</td>
                    <td>{floorsNumber(lift.floor)}F</td>
                    <td style={{ color: display.color }}>{display.symbol}</td>
                    <td>{floorsNumber(lift.load_pct, 1)}%</td>
                    <td
                      style={{
                        color: lift.load_pct >= 80 ? "#e5be6a" : "#2fbf8f",
                      }}
                    >
                      {elevatorOperatingStatus(lift.load_pct)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
