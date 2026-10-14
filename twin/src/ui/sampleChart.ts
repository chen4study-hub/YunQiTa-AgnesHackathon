import type { EChartsOption } from "echarts";

// Fixed component-fixture values, not model experiment results or API responses.
const prediction = [
  840, 820, 830, 850, 870, 900, 990, 1180, 1500, 1820, 2110, 2360, 2520, 2589,
  2520, 2280, 1940, 1620, 1410, 1320, 1150, 980, 890, 850,
];

export const sampleChart: EChartsOption = {
  animation: false,
  grid: { left: 58, right: 30, top: 45, bottom: 58 },
  legend: {
    data: ["预测", "90% 区间", "实测"],
    bottom: 8,
    icon: "rect",
    itemWidth: 12,
    itemHeight: 5,
  },
  xAxis: {
    type: "category",
    boundaryGap: false,
    data: prediction.map((_, i) => `${String(i).padStart(2, "0")}:00`),
    axisLabel: { interval: 5 },
  },
  yAxis: {
    type: "value",
    min: 0,
    max: 3000,
    name: "kW",
    nameTextStyle: { color: "#5B6B76", fontSize: 12 },
  },
  series: [
    {
      name: "下界",
      type: "line",
      stack: "interval",
      data: prediction.map((value) => value * 0.91),
      symbol: "none",
      lineStyle: { opacity: 0 },
      areaStyle: { opacity: 0 },
      tooltip: { show: false },
    },
    {
      name: "90% 区间",
      type: "line",
      stack: "interval",
      data: prediction.map((value) => value * 0.18),
      symbol: "none",
      lineStyle: { opacity: 0 },
      areaStyle: { color: "#4FD1D9", opacity: 0.12 },
    },
    {
      name: "预测",
      type: "line",
      data: prediction,
      symbol: "none",
      smooth: 0.2,
      lineStyle: { color: "#4FD1D9", width: 2 },
      markLine: {
        symbol: "none",
        label: { show: false },
        lineStyle: { color: "#4FD1D9", type: "dashed", width: 1 },
        data: [{ xAxis: 14 }],
      },
    },
    {
      name: "实测",
      type: "line",
      data: prediction.map((value, i) =>
        i <= 14 ? Math.round(value + Math.sin(i) * 45) : null,
      ),
      symbol: "none",
      lineStyle: { color: "#E4ECF1", width: 1 },
    },
  ],
};
