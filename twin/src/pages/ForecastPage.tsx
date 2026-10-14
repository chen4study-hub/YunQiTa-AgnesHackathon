import { useMemo } from "react";
import { useDashboard } from "../state/context";
import { forecastView } from "./forecast/data";
import { ForecastContent } from "./forecast/ForecastContent";
import "./forecast/forecast.css";
import "./forecast/readable-layout.css";

export function ForecastPage() {
  const { state, store } = useDashboard();
  // Contract 1.2 is hourly: advance with the actual replay cursor, not the
  // destination hour selected during seek/playback. Never interpolate flags.
  const hour = Math.max(0, Math.min(23, Math.floor(state.time)));
  const view = useMemo(
    () => (state.data ? forecastView(state.data, hour) : null),
    [state.data, hour],
  );
  if (!state.data || !view)
    return (
      <div className="forecast-loading" role="status">
        预测与风险数据加载中…
      </div>
    );
  const current = state.data.hours[hour];
  return (
    <ForecastContent
      view={view}
      current={current}
      floors={current.floors_kw}
      modelCard={state.modelCard}
      scenario={state.scenario}
      nowMs={state.nowMs}
      labelOrigin={view.current_t}
      playback={{
        data: state.data,
        store,
        startMs: state.playbackStartMs,
        elapsedHours: state.playbackElapsedHours,
        playing: state.playing,
      }}
    />
  );
}
