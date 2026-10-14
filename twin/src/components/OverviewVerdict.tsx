import { useLayoutEffect, useRef, useState } from 'react';
import { Card } from "./Card";
import { OverviewStatusText } from './OverviewStatusText';
import { useActiveTakeover } from "../data/useActiveTakeover";
import { OverviewTakeover } from "./OverviewTakeover";
import './overview-takeover.css';

import { formatOverviewQuantities } from '../ui/overviewQuantity';
export const formatOverviewAction = (value: string) => formatOverviewQuantities(value).replace(/\b(BA|EMS)(?=[\u3400-\u9fff])/g, '$1 ');
import { agentVerdict } from "../data/overview";
import { clockTime } from "../data/interpolate";
import type { Hour } from "../data/types";
import type { Scenario } from '../state/store';
import { formatDisplayDate } from '../config/presentation';
import type { LiveSchedule } from '../data/liveSchedule';
import { storagePower } from '../pages/agent/data';
import {decisionSourceLabel,decisionSourceTitle} from '../config/decisionSource';
import { replayCalendar } from '../ui/replayCalendar';

function VerdictBody({
  hour,
  time,
  date,
}: {
  hour: Hour;
  time: number;
  date: string;
}) {
  const rawVerdict = agentVerdict(hour, date, Math.floor(time));
  const verdict = { ...rawVerdict, explanation: formatOverviewQuantities(rawVerdict.explanation), reason: formatOverviewQuantities(rawVerdict.reason) };
  const provenance={selectionSource:hour.agent.source,explanationSource:hour.agent.explanation_source};
  return (
    <>
      <small><span className="overview-decision-source" title={decisionSourceTitle(provenance)}>{decisionSourceLabel(provenance)}</span> · {clockTime(time)}</small>
      <div
        className={`dispatch-banner ${verdict.handoff ? "handoff-banner" : ""}`}
      >
        <b>
          <OverviewStatusText text={verdict.handoff ? "转交人工 · 暂停自动下发" : "已自动下发 · 执行中"} />
        </b>
        <small>
          <OverviewStatusText text={verdict.handoff
            ? "暂停下发 · 人工复核"
            : `${String(Math.floor(time)).padStart(2, "0")}:00 下发 · ${verdict.receiptNormal ? "回执正常" : "无回执记录"}`} />
        </small>
      </div>
      {verdict.handoff ? (
        <>
          <p className="verdict-two-lines" title={verdict.explanation}>
            <OverviewStatusText text={verdict.explanation} />
          </p>
          <p className="verdict-two-lines" title={verdict.reason}>
            原因：<OverviewStatusText text={verdict.reason} />
          </p>
          <div className="work-order" title={verdict.order}>
            {verdict.order}
          </div>
          <small>
            {verdict.orderGenerated ? "展示编号 · 数据未含工单ID" : "工单编号"}
          </small>
        </>
      ) : (
        <>
          <p className="verdict-two-lines" title={verdict.explanation}>
            <OverviewStatusText text={verdict.explanation} />
          </p>
          <ul aria-label="操作要点">
            {(verdict.actions.length
              ? verdict.actions.slice(0, 2)
              : ["暂无操作要点"]
            ).map((action) => (
              <li className="verdict-two-lines" title={formatOverviewAction(action)} key={action}>
                <OverviewStatusText text={formatOverviewAction(action)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
function LiveVerdictBody({decision,scenario,time,nowMs}:{decision:LiveSchedule;scenario:Scenario;time:number;nowMs?:number}) {
  const calendarText=replayCalendar(scenario,decision.t,nowMs).text;
  const show=(value:string)=>formatOverviewQuantities(calendarText(value));
  const selected=decision.candidates.find(c=>c.id===decision.selected);
  return <>
    <small><span className="overview-decision-source" title={decisionSourceTitle(decision)}>{decisionSourceLabel(decision)}</span> · {clockTime(time)}</small>
    <div className={`dispatch-banner ${decision.handoff?'handoff-banner':''}`}>
      <b><OverviewStatusText text={decision.handoff?'转交人工 · 暂停自动下发':decision.receipt.count>0?'已自动下发 · 执行中':'自动方案 · 回执暂无数据'} /></b>
      <small><OverviewStatusText text={decision.handoff?'暂停下发 · 人工复核':`${String(Math.floor(time)).padStart(2,'0')}:00 下发 · ${decision.receipt.count>0?'回执正常':'无回执记录'}`} /></small>
    </div>
    <p className="verdict-two-lines" title={show(decision.reason)}><OverviewStatusText text={show(decision.reason)} /></p>
    <ul aria-label="当前实时调度">
      <li className="overview-selected-plan">选择：<OverviewStatusText text={selected?.name ?? decision.selected} /></li>
      <li className="overview-storage-power">储能 <OverviewStatusText text={storagePower(decision.battery)} /></li>
    </ul>
    {decision.handoff&&<div className="work-order">{show(decision.ticket.id)}</div>}
  </>;
}
/** Grid owns desktop height; the body scrolls internally. Mobile follows content height. */
export function OverviewVerdict({
  scenario,
  hour,
  time,
  liveDecision,
  nowMs,
}: {
  scenario: Scenario;
  hour: Hour;
  liveDecision?: LiveSchedule | null;
  nowMs?: number;
  time: number;
}) {
  const date = formatDisplayDate(nowMs).slice(0, 10);
  const takeover = useActiveTakeover(date, Math.floor(time));
  const active = takeover?.record_status === 'active';
  const cancelled = takeover?.record_status === 'cancelled';
  // Cancellation restores the exported hourly decision, not a cached manual schedule.
  const decision = cancelled ? null : liveDecision;
  const exported = agentVerdict(hour, date, Math.floor(time));
  const handoff = decision ? decision.handoff : exported.handoff;
  const receiptNormal = decision ? decision.receipt.count > 0 : exported.receiptNormal;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setMoreBelow(!active && el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer.disconnect(); el.removeEventListener('scroll', update); };
  }, [decision, hour, date, time, active, cancelled]);
  return (
    <Card label="Agent 结论" className="agent-verdict">
      <h2>Agent 结论</h2>
      <div className="overview-verdict-scroll-shell" data-more-below={moreBelow}>
      <div
        ref={scrollRef}
        className="verdict-body overview-verdict-stack"
        role="group"
        aria-label="Agent 结论摘要，完整记录见 Agent 决策页"
        data-decision-source={decision?'schedule':'replay'}
        data-selected={decision?.selected}
        data-battery-kw={decision?.battery}
      >
        {cancelled && <OverviewTakeover record={takeover} nowMs={nowMs ?? Date.now()} />}
        <div className="overview-verdict-default" aria-hidden={active ? true : undefined}>
          {decision ? <LiveVerdictBody decision={decision} scenario={scenario} time={time} nowMs={nowMs} /> : <VerdictBody hour={hour} time={time} date={date} />}
        </div>
        {active && <OverviewTakeover record={takeover} nowMs={nowMs ?? Date.now()} />}
      </div>
      </div>
      <div className="dispatch-note overview-verdict-footer" aria-hidden={active ? true : undefined}>
        <OverviewStatusText text={handoff ? '整点调度 · 已转人工' : `整点调度 · ${receiptNormal ? '回执已记录' : '暂无回执记录'}`} />
      </div>
    </Card>
  );
}
