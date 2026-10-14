import { useLayoutEffect, useRef, useState } from "react";
import shell from "./DashboardShell.module.css";
import { Button } from "./Button";
import { useDashboard } from "../state/context";
import { formatDisplayTimestamp } from "../config/presentation";
import { Timeline } from "./Timeline";
import type { PlaybackFrame } from '../state/store';

export function BottomBar() {
  const { state, store } = useDashboard();
  const displayFrame = store.getPlaybackFrame();
  const footer = useRef<HTMLElement>(null);
  const clock = useRef<HTMLTimeElement>(null);
  useLayoutEffect(() => {
    const update = (frame: PlaybackFrame) => {
      if (clock.current) {
        clock.current.textContent = formatDisplayTimestamp(frame.nowMs);
        clock.current.dataset.nowMs = String(frame.nowMs);
      }
    };
    update(displayFrame);
    return store.subscribePlayback(update);
  }, [store]);
  useLayoutEffect(() => {
    const element = footer.current;
    const dashboard = element?.closest<HTMLElement>(".dashboard");
    if (!element || !dashboard) return;
    const measure = () =>
      dashboard.style.setProperty(
        "--footer-height",
        `${element.getBoundingClientRect().height}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      dashboard.style.removeProperty("--footer-height");
    };
  }, []);
  const source = state.data?.meta.data_source;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const finished = state.playbackFinished;
  const viewingCurrent =
    state.playbackStartMs === null &&
    (state.followingCurrent || store.getPlaybackFrame().nowMs === store.getRealNowMs());
  return (
    <footer ref={footer} className={`bottombar ${shell.bottom}`}>
      <Button
        variant="primary"
        aria-pressed={state.playing}
        onClick={() => store.togglePlayback()}
      >
        {state.playing ? "Ⅱ 暂停" : finished ? "↺ 重置" : "▶ 播放"}
      </Button>
      <div className={shell.clockControls}>
        <time ref={clock} className="clock" aria-label="当前本地时间" data-now-ms={displayFrame.nowMs}>
          {formatDisplayTimestamp(displayFrame.nowMs)}
        </time>
        <span className={shell.currentReturn}>
          {!viewingCurrent && (
            <Button onClick={() => store.returnToCurrent()}>回到当前</Button>
          )}
        </span>
      </div>
      <div className="timeline-scroll">
        <Timeline
          store={store}
          initialFrame={displayFrame}
          time={state.time}
          playing={state.playing}
          playbackStartMs={state.playbackStartMs}
          playbackElapsedHours={state.playbackElapsedHours}
          data={state.data}
          onChange={(time) => store.setHour(time)}
        />
      </div>
      {source && (
        <span className={shell.mobileCredit}>
          BDG2 · Miller et al., 2020 · CC BY-SA 4.0
        </span>
      )}
      <div className="footer-details" data-expanded={detailsOpen}>
        <button
          className="footer-details-toggle"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((value) => !value)}
        >
          峰谷 / 署名
        </button>
        <div className="footer-popover">
          <span className="time-legend">
            <i className="measured" />
            实测 <i className="forecast" />
            预测
            <i className="peak" />
            峰时 <i className="valley" />
            谷时 <i className="reject" />
            拒绝预测
          </span>
          {source && (
            <a
              className="credit"
              href={source.url}
              title={`${source.attribution}\n${source.modifications}`}
              target="_blank"
              rel="noreferrer"
            >
              BDG2：Miller et al., 2020, Scientific Data 7, 368 · CC BY-SA 4.0
            </a>
          )}
        </div>
      </div>
    </footer>
  );
}
