import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { ReplayData } from "../data/types";
import { clockTime } from "../data/interpolate";
import { formatDisplayTimestamp } from "../config/presentation";
import {
  formatRelativeTime,
  hourOnDisplayDay,
  localCalendarDate,
} from "../config/displayTime";
import "./timelinePlayback.css";
import type { DashboardStore, PlaybackFrame } from "../state/store";
import { timelineEvidence } from "./timelineEvidence";

/** Keep the data hour discrete; only the live visual head includes local minutes/seconds. */
export function timelineHeadTime(
  frame: PlaybackFrame,
  followingCurrent: boolean,
  playbackStartMs: number | null,
) {
  if (!followingCurrent || playbackStartMs !== null) return frame.time;
  const date = new Date(frame.nowMs);
  return (
    date.getHours() +
    date.getMinutes() / 60 +
    date.getSeconds() / 3600 +
    date.getMilliseconds() / 3_600_000
  );
}

/** 24 equal visual cells; the last cell is the 23:00 replay endpoint. */
export function timelineTimeAtX(
  x: number,
  left: number,
  width: number,
  continuous: boolean,
) {
  if (width <= 0) return 0;
  const time = Math.max(0, Math.min(23, ((x - left) / width) * 24));
  return continuous ? time : Math.floor(time);
}
export function Timeline({
  store,
  initialFrame,
  time,
  playing,
  playbackStartMs = null,
  playbackElapsedHours = 0,
  data,
  onChange,
}: {
  store?: DashboardStore;
  initialFrame?: PlaybackFrame;
  time: number;
  playing: boolean;
  playbackStartMs?: number | null;
  playbackElapsedHours?: number;
  data: ReplayData | null;
  onChange: (time: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!root.current) return;
    const element = root.current;
    const slider = element.querySelector<HTMLElement>(".timeline-slider")!;
    const cells = Array.from(
      element.querySelectorAll<HTMLElement>("[data-hour]"),
    );
    let lastHour = -1,
      evidenceKey = "";
    let cellBounds: {
      left: number;
      top: number;
      width: number;
      height: number;
    }[] = [];
    const placeSelection = (hour: number) => {
      const bounds = cellBounds[hour];
      if (!bounds) return;
      Object.assign(slider.style, {
        left: `${bounds.left}px`,
        top: `${bounds.top}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
      });
    };
    const measureCells = () => {
      const bounds = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      const borderLeft = parseFloat(css.borderLeftWidth),
        borderTop = parseFloat(css.borderTopWidth);
      cellBounds = cells.map((cell) => {
        const rect = cell.getBoundingClientRect();
        return {
          left: rect.left - bounds.left - borderLeft,
          top: rect.top - bounds.top - borderTop,
          width: rect.width,
          height: rect.height,
        };
      });
      placeSelection(Math.floor(store?.getPlaybackFrame().time ?? time));
    };
    // Read layout only when it changes, never on every playback frame.
    measureCells();
    const observer = new ResizeObserver(measureCells);
    observer.observe(element);
    cells.forEach((cell) => observer.observe(cell));
    if (!store) return () => observer.disconnect();
    const update = (frame: PlaybackFrame) => {
      const hour = Math.floor(frame.time);
      element.dataset.nowMs = String(frame.nowMs);
      const state = store.getSnapshot();
      const head = timelineHeadTime(
        frame,
        state.followingCurrent,
        state.playbackStartMs,
      );
      // The frame follows the real selected cell; only its inner head is fractional.
      placeSelection(hour);
      slider.style.setProperty("--cursor-fraction", String(head % 1));
      element.dataset.headTime = String(head);
      const realMs = store.getRealNowMs();
      if (hour !== lastHour) {
        cells.forEach((cell, i) =>
          cell.classList.toggle("current", i === hour),
        );
        lastHour = hour;
      }
      const key = `${new Date(frame.nowMs).toDateString()}|${hour}|${Math.floor(realMs / 60000)}|${state.playbackStartMs !== null}`;
      if (key !== evidenceKey)
        cells.forEach((cell, i) => {
          const evidence = timelineEvidence(
            i,
            frame.nowMs,
            realMs,
            state.playbackStartMs !== null,
          );
          cell.dataset.evidence = evidence.kind;
          cell.style.setProperty(
            "--measured-percent",
            `${evidence.measured * 100}%`,
          );
          cell.dataset.nextDay = String(evidence.nextDay);
          cell.title = `${formatRelativeTime(hourOnDisplayDay(frame.nowMs, i), frame.nowMs)} · ${evidence.kind === "measured" ? "实测" : "预测"}`;
        });
      const marker = element.querySelector<HTMLElement>(".timeline-date-label");
      if (marker) marker.textContent = localCalendarDate(frame.nowMs).slice(5);
      evidenceKey = key;
      element.dataset.time = String(frame.time);
      element.dataset.elapsedHours = String(frame.elapsedHours);
      element.dataset.dayOffset = String(
        state.playbackStartMs === null
          ? 0
          : Math.floor(
              (new Date(state.playbackStartMs).getHours() +
                new Date(state.playbackStartMs).getMinutes() / 60 +
                frame.elapsedHours) /
                24,
            ),
      );
      element.setAttribute("aria-valuenow", String(frame.time));
      element.setAttribute(
        "aria-valuetext",
        formatDisplayTimestamp(frame.nowMs),
      );
    };
    update(initialFrame ?? store.getPlaybackFrame());
    const unsubscribe = store.subscribePlayback(update);
    return () => {
      unsubscribe();
      observer.disconnect();
    };
    // A store-backed slider reads live frame/state. Do not resubscribe and force
    // 24 cell layout reads synchronously on play or at each hourly boundary.
  }, [store, store ? null : playbackStartMs, store ? null : time]);
  const hour = Math.floor(time);
  const renderFrame = initialFrame ?? store?.getPlaybackFrame();
  const head = renderFrame
    ? timelineHeadTime(
        renderFrame,
        store!.getSnapshot().followingCurrent,
        playbackStartMs,
      )
    : time;
  const displayMs =
    renderFrame?.nowMs ??
    (playbackStartMs === null
      ? Date.now()
      : playbackStartMs + playbackElapsedHours * 3_600_000);
  const nextDay =
    playbackStartMs !== null &&
    localCalendarDate(displayMs) !== localCalendarDate(playbackStartMs);
  const pointer = useRef<{ id: number; x: number; moved: boolean } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const position = (
    event: PointerEvent<HTMLDivElement>,
    continuous: boolean,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onChange(timelineTimeAtX(event.clientX, rect.left, rect.width, continuous));
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { id: event.pointerId, x: event.clientX, moved: false };
    setDragging(true);
    position(event, false);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    active.moved ||= Math.abs(event.clientX - active.x) > 3;
    if (active.moved) position(event, true);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const active = pointer.current;
    if (!active || active.id !== event.pointerId) return;
    position(event, active.moved);
    pointer.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancel = () => {
    pointer.current = null;
    setDragging(false);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = store?.getPlaybackFrame().time ?? time;
    const target = (
      {
        ArrowLeft: current - 1,
        ArrowDown: current - 1,
        ArrowRight: current + 1,
        ArrowUp: current + 1,
        Home: 0,
        End: 23,
        PageDown: current - 6,
        PageUp: current + 6,
      } as Record<string, number>
    )[event.key];
    if (target === undefined) return;
    event.preventDefault();
    onChange(Math.max(0, Math.min(23, target)));
  };
  return (
    <div
      ref={root}
      className="timeline"
      role="slider"
      tabIndex={0}
      aria-label="24 小时时间轴"
      aria-valuemin={0}
      aria-valuemax={23}
      aria-valuenow={time}
      aria-valuetext={
        renderFrame ? formatDisplayTimestamp(renderFrame.nowMs) : playbackStartMs === null
          ? clockTime(time)
          : formatDisplayTimestamp(
              playbackStartMs + playbackElapsedHours * 3_600_000,
            )
      }
      aria-orientation="horizontal"
      data-time={time}
      data-now-ms={renderFrame?.nowMs}
      data-head-time={head}
      data-playing={playing}
      data-day-offset={nextDay ? 1 : 0}
      data-elapsed-hours={playbackElapsedHours}
      data-dragging={dragging}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={key}
    >
      <small className="timeline-date-label" aria-hidden="true">
        {localCalendarDate(displayMs).slice(5)}
      </small>
      <span
        className="timeline-slider"
        aria-hidden="true"
        style={
          {
            "--cursor-fraction": head % 1,
          } as CSSProperties
        }
      >
        <span
          className="timeline-cursor"
          style={{ transform: `translateX(${(head % 1) * 100}%)` }}
        />
      </span>
      {Array.from({ length: 24 }, (_, cell) => (
        <span
          key={cell}
          aria-hidden="true"
          data-hour={cell}
          title={formatRelativeTime(
            hourOnDisplayDay(displayMs, cell),
            displayMs,
          )}
          className={`timeline-cell ${data?.hours[cell].abstain ? "reject" : cell >= 9 && cell <= 20 ? "peak" : "valley"} ${cell === hour ? "current" : ""}`}
        >
          {(cell % 3 === 0 || cell === 23 || cell === hour) && (
            <small className="desktop-hour-label">
              {String(cell).padStart(2, "0")}
            </small>
          )}
        </span>
      ))}
      {[0, 6, 12, 18].map((cell) => (
        <small
          key={cell}
          aria-hidden="true"
          className="mobile-hour-label"
          style={{ left: `${(cell / 24) * 100}%` }}
        >
          {cell}
        </small>
      ))}
    </div>
  );
}
