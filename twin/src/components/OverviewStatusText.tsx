import "./overview-status-text.css";
import {
  formatOverviewQuantities,
  overviewQuantityPattern,
} from "../ui/overviewQuantity";

// Keep semantic status words atomic while surrounding sentences can still wrap.
const statuses =
  "暂停自动下发|已自动下发|暂无回执记录|回执暂无数据|回执已记录|无回执记录|转人工复核|人工接管中|整栋转人工|自动调度|转交人工|拒绝预测|正常运行|暂停下发|人工复核|已转人工|转人工|回执正常|自动方案|已下发|已撤销|执行中|正常|待机|充电|放电";
const atomicText = new RegExp(`(${overviewQuantityPattern}|${statuses})`, "g");
export function OverviewStatusText({ text }: { text: string }) {
  return (
    <>
      {formatOverviewQuantities(text)
        .split(atomicText)
        .map((part, index) =>
          index % 2 ? (
            <i className="overview-status-word" key={index}>
              {part}
            </i>
          ) : (
            part
          ),
        )}
    </>
  );
}
