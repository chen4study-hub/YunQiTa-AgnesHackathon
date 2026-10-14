import { useMemo, useState, memo } from "react";
import { TwinSceneView } from "./TwinSceneView";
import { Button } from "./Button";
import { useDashboard } from "../state/context";
import type { TwinSceneOptions } from "../core/TwinScene";
import './sceneTools.css';
import { sampleFrame } from "../data/interpolate";
import { FLOOR_COLORS, EQUIPMENT_COLOR } from '../ui/floorColors';
import { opsFloorScale } from '../data/ops/floorColors';
import { useOpsDay } from '../data/ops/useOpsDay';

const options: TwinSceneOptions = {
  building: {
    floors: 40,
    sqm: 80000,
    twistDeg: 78,
    baseWidth: 6.5,
    topWidth: 4.2,
    taperExponent: 0.8,
    gardenFloors: [14, 27],
  },
  campusCount: 150,
};
export const OverviewScene=memo(function OverviewScene() {
  const { state, store } = useDashboard(2);
  const [resetKey, setResetKey] = useState(0);
  const frame = useMemo(
    () => (state.data ? sampleFrame(state.data, state.time) : null),
    [state.data, state.time],
  );
  const day = useOpsDay(state.nowMs);
  const scale = useMemo(()=>day ? opsFloorScale(day) : undefined,[day]);
  const s = state.switches;
  return (
    <section
      className="overview-scene"
      style={{ gridArea: "scene" }}
      aria-label="总览三维场景"
    >
      {frame && (
        <TwinSceneView
          options={options}
          active={state.page === 'overview'}
          resetKey={resetKey}
          frame={frame}
          floorColorScale={scale}
          floorUses={day?.hours[0].floors.map(floor => floor.use)}
          mode={s.mode}
          exploded={s.exploded}
          xray={s.xray}
          lowQuality={s.quality === "low"}
          autoRotate={s.autoRotate}
          selectedFloor={
            state.selectedFloor === null ? null : state.selectedFloor - 1
          }
          onFloorClick={(floor) => store.selectFloor(floor + 1)}
        />
      )}
      <div className="scene-heading">
        云栖塔 · 数字孪生{" "}
        <small>40 层 / 78° 螺旋塔楼 · 楼层与设备数字映射</small>
      </div>
      <div
        className="scene-tools"
        role="toolbar"
        aria-label="三维场景控件"
      >
        <Button onClick={() => setResetKey((key) => key + 1)}>重置视角</Button>
        <Button
          aria-pressed={s.autoRotate}
          onClick={() => store.setSwitch("autoRotate", !s.autoRotate)}
        >
          自动旋转
        </Button>
        <Button
          aria-pressed={s.quality === "low"}
          onClick={() =>
            store.setSwitch("quality", s.quality === "low" ? "high" : "low")
          }
        >
          低画质
        </Button>
        {state.selectedFloor !== null && (
          <Button onClick={() => store.selectFloor(null)}>
            {state.selectedFloor}F · 取消选择
          </Button>
        )}
        <Button
          aria-pressed={s.mode === "heat"}
          onClick={() => store.setSwitch("mode", "heat")}
        >
          能耗着色
        </Button>
        <Button
          aria-pressed={s.mode === "real"}
          onClick={() => store.setSwitch("mode", "real")}
        >
          真实外观
        </Button>
        <Button
          aria-pressed={s.xray}
          onClick={() => store.setSwitch("xray", !s.xray)}
        >
          透视
        </Button>
        <Button
          aria-pressed={s.exploded}
          onClick={() => store.setSwitch("exploded", !s.exploded)}
        >
          展开楼层
        </Button>
      </div>
      <div className="scene-legend" aria-label="办公层 08:00–20:00 固定分位数色标，设备层独立显示">
        {['低','中','高'].map((label,index)=><span key={label}><i style={{background:FLOOR_COLORS[index]}} />{label} <span className="overview-quantity-value">{scale ? [scale.p10,scale.p50,scale.p90][index].toFixed(1) : '—'} kW</span> · p{[10,50,90][index]} </span>)}
        <span><i style={{background:EQUIPMENT_COLOR}} />设备层</span>
        <span><i style={{background:'#ff4d5e'}} />整栋转人工</span>
      </div>
    </section>
  );
});
