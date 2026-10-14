import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDashboard } from "../state/context";
import { PageGrid } from "../components/PageGrid";
import { replayDecision } from "./agent/data";
import { health, loadSchedule, invalidateSchedule } from "./agent/api";
import { DecisionCard } from "./agent/DecisionCard";
import { RecordTable } from "./agent/RecordTable";
import { ChatPanel } from "./agent/ChatPanel";
import type { Decision, RecordStatus } from "./agent/types";
import { replayCalendar } from "../ui/replayCalendar";
import { createSource } from "../data/source";
import { localDateKey } from "../config/localClock";
import { loadPreviousDay, type PreviousDay } from "./agent/record-history";
import {
  formatDisplayDate,
  formatDisplayTimestamp,
} from "../config/presentation";
import "./agent/agent.css";
import "./agent/decision-layout.css";
import "./agent/readable-layout.css";

export function AgentPage() {
  const { state } = useDashboard();
  const detailSource = useMemo(() => createSource(window.location.search), []);
  const [leftTab, setLeftTab] = useState<"decision" | "records">("decision");
  const tabs = (
    <div className="agent-left-tabs" role="tablist" aria-label="决策内容">
      {[
        ["decision", "当前决策"],
        ["records", "近期记录（6 小时）"],
      ].map(([value, label]) => (
        <button
          type="button"
          role="tab"
          key={value}
          aria-selected={leftTab === value}
          onClick={() => setLeftTab(value as "decision" | "records")}
        >
          {label}
        </button>
      ))}
    </div>
  );
  const index = Math.max(0, Math.min(23, Math.floor(state.time)));
  const dateKey = localDateKey(state.nowMs);
  const [previous, setPrevious] = useState<{
    key: string;
    value: PreviousDay | null;
  } | null>(null);
  useEffect(() => {
    if (index >= 5 || state.loading || !state.data) return;
    let active = true;
    void loadPreviousDay(detailSource, state.nowMs).then((value) => {
      if (active) setPrevious({ key: dateKey, value });
    });
    return () => {
      active = false;
    };
  }, [detailSource, dateKey, index < 5, state.loading, Boolean(state.data)]);
  const fallback = useMemo(
    () => (state.data ? replayDecision(state.data, index) : null),
    [state.data, index],
  );
  const scopeKey = `${dateKey}|${state.scenario}`;
  const key = `${scopeKey}|${fallback?.t}`;
  const [remote, setRemote] = useState<{
    key: string;
    decision: Decision;
  } | null>(null);
  const [online, setOnline] = useState<boolean | undefined>(undefined),
    [pendingKey, setPendingKey] = useState<string | null>(null);
  const [backendConnected, setBackendConnected] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, RecordStatus>>({});
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [restore, setRestore] = useState<{
    key: string;
    state: "pending" | "error";
  } | null>(null);
  const liveKey = useRef(key),
    writeRevision = useRef(0);
  liveKey.current = key;
  useEffect(
    () => () => {
      liveKey.current = "";
    },
    [],
  );
  const refreshSchedule = useCallback(
    async (change: "created" | "cancelled") => {
      if (!state.data) return;
      const revision = ++writeRevision.current;
      invalidateSchedule(state.data, index, state.scenario, dateKey);
      setRestore(change === "cancelled" ? { key, state: "pending" } : null);
      setRemote(null);
      setPendingKey(key);
      setStatuses((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      setDecisions((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      // Explicit successful writes must refresh even at a fractional slider position.
      const decision = await loadSchedule(
        state.data,
        index,
        state.scenario,
        dateKey,
      );
      if (liveKey.current !== key || writeRevision.current !== revision) return;
      setRemote(decision ? { key, decision } : null);
      if (change === "cancelled")
        setRestore(decision ? null : { key, state: "error" });
      if (decision) {
        setDecisions((previous) => ({ ...previous, [key]: decision }));
        setBackendConnected(true);
      }
      setPendingKey(null);
    },
    [state.data, index, state.scenario, dateKey, key],
  );
  useEffect(() => {
    let active = true;
    void health().then((v) => {
      if (active) setOnline(v);
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const revision = writeRevision.current;
    if (
      state.data &&
      !state.loading &&
      !state.playing &&
      state.time === state.hour &&
      state.playbackStartMs === null
    ) {
      setPendingKey(key);
      void loadSchedule(state.data, index, state.scenario, dateKey).then(
        (decision) => {
          if (!active || revision !== writeRevision.current) return;
          setRemote(decision ? { key, decision } : null);
          if (decision)
            setDecisions((previous) => ({ ...previous, [key]: decision }));
          setPendingKey(null);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [
    state.data,
    state.scenario,
    state.loading,
    state.playing,
    state.time,
    state.hour,
    state.playbackStartMs,
    index,
    key,
  ]);
  if (!state.data || !fallback || state.loading)
    return (
      <div className="agent-loading" role="status">
        Agent 数据加载中…
      </div>
    );
  const decision =
    state.playbackStartMs === null && remote?.key === key
      ? remote.decision
      : fallback;
  // replayCalendar maps decision.t's date onto the footer's current local date.
  const labelOrigin = decision.t;
  const show = replayCalendar(state.scenario, decision.t, state.nowMs).text;
  const scoped = Object.fromEntries(
    Object.entries(statuses)
      .filter(([k]) => k.startsWith(`${scopeKey}|`))
      .map(([k, v]) => [k.slice(scopeKey.length + 1), v]),
  );
  return (
    <div
      className="agent-root"
      data-origin={decision.t}
      data-decision-source={decision.source}
      data-display-date={formatDisplayDate(state.nowMs)}
      aria-description={formatDisplayTimestamp(state.nowMs)}
    >
      <PageGrid
        className="agent-page"
        rows="auto auto"
        areas={["left", "chat"]}
        breakpoints={[
          {
            minWidth: 1180,
            columns: "repeat(2, minmax(0, 1fr))",
            rows: "minmax(0, 1fr)",
            areas: ["left chat"],
          },
        ]}
      >
        <div className="agent-left-slot" data-left-tab={leftTab}>
          <DecisionCard
            date={dateKey}
            onConnectionChange={setBackendConnected}
            onTakeoverChanged={refreshSchedule}
            restoration={restore?.key === key ? restore.state : undefined}
            headerTabs={tabs}
            decision={decision}
            onRequestDetail={
              state.data.schema_version === "1.5"
                ? async () => {
                    if (!detailSource.loadAgentDetail)
                      throw new Error("明细不可用");
                    const main = state.data!;
                    const detail = await detailSource.loadAgentDetail(
                      main,
                      index,
                    );
                    const hours = main.hours.map((h, i) =>
                      i === index ? { ...h, agent: detail.agent } : h,
                    );
                    return replayDecision({ ...main, hours }, index);
                  }
                : undefined
            }
            data={state.data}
            index={index}
            online={online}
            pending={pendingKey === key}
            displayText={show}
            labelOrigin={labelOrigin}
            status={statuses[key]}
            onAction={(status) =>
              setStatuses((prev) => ({ ...prev, [key]: status }))
            }
          />
          <RecordTable
            connected={backendConnected}
            headerTabs={tabs}
            previous={previous?.key === dateKey ? previous.value?.data : null}
            data={state.data}
            index={index}
            current={decision}
            statuses={state.playbackStartMs === null ? scoped : {}}
            labelOrigin={labelOrigin}
            decisions={
              state.playbackStartMs === null
                ? Object.fromEntries(
                    Object.entries(decisions)
                      .filter(([k]) => k.startsWith(`${scopeKey}|`))
                      .map(([k, v]) => [k.slice(scopeKey.length + 1), v]),
                  )
                : {}
            }
          />
        </div>
        <div className="agent-chat-slot">
          <ChatPanel
            data={state.data}
            index={index}
            scenario={state.scenario}
            nowMs={state.nowMs}
            labelOrigin={labelOrigin}
            decision={decision}
            online={online}
            onHealthRefresh={() => {
              void health().then(setOnline);
            }}
          />
        </div>
      </PageGrid>
    </div>
  );
}
