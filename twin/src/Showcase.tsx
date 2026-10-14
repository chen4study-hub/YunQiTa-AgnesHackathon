import { useState } from "react";
import { Button } from "./components/Button";
import { Card } from "./components/Card";
import { DataSourceTag } from "./components/DataSourceTag";
import { EChart } from "./components/EChart";
import { Table } from "./components/Table";
import { Title } from "./components/Title";
import { ValueCell } from "./components/ValueCell";
import { sampleChart } from "./ui/sampleChart";

const navigation = [
  ["总览", "OVERVIEW"],
  ["预测与风险", "FORECAST & RISK"],
  ["Agent 决策", "AGENT DECISIONS"],
  ["楼层与电梯", "FLOORS & LIFTS"],
  ["能源与告警", "ENERGY & ALARMS"],
];

export function Showcase() {
  const [hour, setHour] = useState(14);
  const [action, setAction] = useState("");
  return (
    <div className="dashboard">
      <header className="topbar">
        <div className="brand">
          <b>云栖塔</b>
          <span>YUNQI TOWER · 能耗数字孪生</span>
        </div>
        <nav aria-label="页面导航">
          {navigation.map(([label, english], index) => (
            <button
              key={label}
              className={index === 0 ? "nav-item active" : "nav-item"}
              disabled={index !== 0}
            >
              {label}
              <small>{english}</small>
            </button>
          ))}
        </nav>
        <div className="day-switch">
          <span>典型日</span>
          <button>工作日</button>
          <button className="selected">高温日</button>
          <button>节假日</button>
        </div>
        <span className="top-badge green">
          <i />
          系统运行中 LIVE
        </span>
        <span className="top-badge cyan">自动调度 · 低置信度转人工</span>
      </header>
      <main className="showcase-grid">
        <aside className="summary-column">
          <Card className="metric">
            <span>预测负荷（整栋）</span>
            <strong>
              2,589 <small>kW</small>
            </strong>
            <p>90% 区间 2,399–2,779 kW · 实测 2,610</p>
          </Card>
          <Card className="metric">
            <span>今日累计用电</span>
            <strong>
              32,904 <small>kWh</small>
            </strong>
            <p>
              较普通工作日同期 <em>+12.4%</em>
            </p>
          </Card>
          <Card className="metric">
            <span>今日预计电费</span>
            <strong>
              28,913 <small>元</small>
            </strong>
            <p>峰时电价 1.20 元/kWh</p>
          </Card>
          <Card className="metric">
            <span>模型状态</span>
            <strong className="green-text">正常</strong>
            <p>置信度 85% · 共计 40 个楼层</p>
          </Card>
          <Card className="daily-summary">
            <Title subtitle="DAILY SUMMARY">今日概况</Title>
            <div className="value-grid two">
              <ValueCell label="预测峰值" value="2,680" unit="kW" />
              <ValueCell label="峰值时刻" value="13:00" />
              <ValueCell label="拒绝预测时段" value="0" unit="小时" />
              <ValueCell label="自动调度 / 转人工" value="15 / 0" />
            </div>
          </Card>
        </aside>
        <div className="center-column">
          <Card className="environment-card">
            <Title
              subtitle="ENVIRONMENT & OCCUPANCY"
              trailing={<DataSourceTag name="IoT 传感" />}
            >
              环境与人员
            </Title>
            <div className="value-grid three">
              <ValueCell
                label="室内均温"
                value="26.1"
                unit="°C"
                note="舒适温度 24–27 °C"
              />
              <ValueCell label="相对湿度" value="54" unit="%" note="40–60%" />
              <ValueCell
                label="平均 CO₂"
                value="844"
                unit="ppm"
                note="< 1,000 ppm"
              />
              <ValueCell label="PM2.5" value="18" unit="μg/m³" note="优" />
              <ValueCell
                label="在楼人数"
                value="3,237"
                unit="人"
                note="门禁统计"
              />
              <ValueCell label="停车位" value="440 / 520" note="地下 B1–B3" />
            </div>
          </Card>
          <Card className="forecast-card">
            <Title subtitle="24-HOUR FORECAST" note="90% 区间">
              24 小时预测
            </Title>
            <EChart option={sampleChart} label="24 小时预测、区间与实测曲线" />
          </Card>
        </div>
        <aside className="operations-column">
          <Card>
            <Title subtitle="AGENT VERDICT" note="14:00">
              Agent 结论
            </Title>
            <div className="status-strip">
              <b>
                <i />
                已自动下发 · 执行中
              </b>
              <span>14:00 下发 · 回执正常</span>
            </div>
            <ul>
              <li>储能放电 500 kW 削峰</li>
              <li>空调保持 25 °C，公共区照明降至 60%</li>
            </ul>
            <div className="actions">
              <Button
                variant="primary"
                onClick={() => setAction("执行回执已展开")}
              >
                查看执行回执
              </Button>
              <Button onClick={() => setAction("已选择人工接管")}>
                人工接管
              </Button>
              <Button
                variant="danger"
                onClick={() => setAction("已撤销当前选择")}
              >
                撤销
              </Button>
            </div>
            <div className="action-feedback" role="status">
              {action}
            </div>
          </Card>
          <Card className="sources-card">
            <Title subtitle="DATA CONNECTIONS">数据接入</Title>
            <div className="sources-grid">
              {[
                "BA 系统",
                "梯控接口",
                "分项计量",
                "EMS",
                "IoT 传感",
                "BMS 告警",
              ].map((name) => (
                <DataSourceTag key={name} name={name} />
              ))}
            </div>
          </Card>
          <Card className="alarm-card">
            <Title
              subtitle="ALARMS & TICKETS"
              trailing={<DataSourceTag name="BMS 告警" />}
            >
              告警与工单
            </Title>
            <Table
              label="告警与工单"
              headers={["级别", "时间", "系统", "状态"]}
              rows={[
                [
                  <span className="level warning">二级</span>,
                  "13:42",
                  "空调",
                  <span className="level warning">处理中</span>,
                ],
                [
                  <span className="level warning">二级</span>,
                  "11:20",
                  "储能",
                  <span className="level warning">处理中</span>,
                ],
                [
                  <span className="level info">提示</span>,
                  "09:05",
                  "电梯",
                  <span className="level critical">待处理</span>,
                ],
                [
                  <span className="level info">提示</span>,
                  "08:30",
                  "新风",
                  <span className="level critical">待处理</span>,
                ],
                [
                  <span className="level info">提示</span>,
                  "07:55",
                  "冷站",
                  <span className="level closed">已关闭</span>,
                ],
              ]}
            />
          </Card>
        </aside>
      </main>
      <footer className="bottombar">
        <Button variant="primary" onClick={() => setHour((hour + 1) % 24)}>
          ▶ 播放
        </Button>
        <span className="clock">
          2026-07-23 周四 {String(hour).padStart(2, "0")}:00
        </span>
        <div className="timeline">
          {Array.from({ length: 24 }, (_, i) => (
            <button
              key={i}
              aria-label={`${i}:00`}
              aria-pressed={i === hour}
              className={`${i >= 9 && i <= 20 ? "peak" : "valley"} ${i === hour ? "current" : ""}`}
              onClick={() => setHour(i)}
            >
              {i % 3 === 0 && <small>{String(i).padStart(2, "0")}</small>}
            </button>
          ))}
        </div>
        <span className="time-legend">
          <i className="peak" />
          峰时 <i className="valley" />
          谷时 <i className="reject" />
          拒绝预测
        </span>
        <span className="credit">
          模型训练数据：BDG2（Miller et al., 2020）CC BY-SA 4.0
        </span>
      </footer>
    </div>
  );
}
