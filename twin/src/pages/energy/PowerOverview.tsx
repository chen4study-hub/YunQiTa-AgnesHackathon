import type { OpsHour, OpsDay } from "../../data/ops";
import { energyNumber } from "./data";

/** Fixed per-scenario, per-channel day maxima; seek never rescales a bar. */
export function powerRows(data: OpsDay, hour: OpsHour) {
  return [
    {
      label: "储能",
      key: "storage",
      value: hour.storage.power_kw,
      max: Math.max(
        1,
        ...data.hours.map((h) => Math.abs(h.storage.power_kw ?? 0)),
      ),
    },
    {
      label: "光伏",
      key: "pv",
      value: hour.pv.power_kw,
      max: Math.max(1, ...data.hours.map((h) => Math.abs(h.pv.power_kw ?? 0))),
    },
    {
      label: "市电",
      key: "grid",
      value: hour.grid_kw,
      max: Math.max(1, ...data.hours.map((h) => Math.abs(h.grid_kw ?? 0))),
    },
  ].map((row) => ({
    ...row,
    width:
      row.value === null
        ? null
        : Math.min(100, (Math.abs(row.value) / row.max) * 100),
  }));
}
export function PowerOverview({ data, hour }: { data: OpsDay; hour: OpsHour }) {
  const soc = hour.storage.soc;
  const power = hour.storage.power_kw;
  const percent = energyNumber(soc === null ? null : soc * 100, 1);
  const fill = soc === null ? 0 : Math.min(100, Math.max(0, soc * 100));
  const storageState =
    power === null
      ? "数据暂不可用"
      : power > 0
        ? "放电"
        : power < 0
          ? "充电"
          : "待机";
  return (
    <>
      <div
        className="energy-soc"
        role="meter"
        aria-label="储能 SOC"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={soc === null ? undefined : soc * 100}
        aria-valuetext={soc === null ? "数据暂不可用" : `${percent}%`}
      >
        <svg
          className="energy-soc-gauge"
          viewBox="0 0 120 90"
          aria-hidden="true"
        >
          <path
            className="energy-soc-base"
            d="M 21.9 76 A 44 44 0 1 1 98.1 76"
            pathLength="100"
          />
          <path
            className="energy-soc-fill"
            d="M 21.9 76 A 44 44 0 1 1 98.1 76"
            pathLength="100"
            strokeDasharray={`${fill} 100`}
          />
        </svg>
        <div className="energy-soc-reading">
          <b className="type-number" data-unit="%">
            <span className="energy-number">{percent}</span>
            <small className="type-unit">%</small>
          </b>
          <span>储能 SOC</span>
        </div>
      </div>
      <div
        className="energy-current-powers"
        aria-label="即时功率；各条按当日各自最大绝对功率归一化"
      >
        {powerRows(data, hour).map((row) => (
          <div
            key={row.key}
            className="energy-power-row"
            data-channel={row.key}
            data-value={row.value}
            data-scale-max={row.max}
          >
            <span>{row.label}</span>
            <div className="energy-power-track" aria-hidden="true">
              <i
                className={`energy-power-fill energy-power-${row.key}`}
                style={{ width: `${row.width ?? 0}%` }}
              />
            </div>
            <b
              title={
                row.key === "storage"
                  ? `${storageState}；正放电、负充电`
                  : undefined
              }
            >
              <span className="energy-number">
                {energyNumber(row.value, 1)}
              </span>
              {"\u00a0"}
              kW
            </b>
          </div>
        ))}
      </div>
    </>
  );
}
