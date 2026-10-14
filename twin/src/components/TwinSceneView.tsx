import { useEffect, useLayoutEffect, useRef } from "react";
import { TwinScene, type TwinSceneOptions } from "../core/TwinScene";
import { GeometryCache } from "../core/geometryCache";
import type { TwinFrame } from "../data/types";
import type { FloorColorScale } from "../ui/floorColors";
import { formatNumber as n } from "../data/overview";
import { layoutSceneLabels } from "./sceneLabelLayout";
import "./scene-labels.css";
import { OverviewStatusText } from './OverviewStatusText';
import { useContext } from "react";
import { StoreContext } from "../state/context";
import { sampleFrame } from "../data/interpolate";
import { opsTimeline } from "../data/ops/runtime";

interface TwinSceneViewProps {
  options: TwinSceneOptions;
  frame: TwinFrame;
  floorColorScale?: FloorColorScale;
  floorUses?: readonly string[];
  active?: boolean;
  mode?: "heat" | "real";
  exploded?: boolean;
  xray?: boolean;
  lowQuality?: boolean;
  autoRotate?: boolean;
  resetKey?: number;
  selectedFloor?: number | null;
  onFloorClick?: (floor: number) => void;
}

/** The core owns only its canvas; React owns the container and lifecycle. */
export function TwinSceneView({
  options,
  frame,
  floorColorScale,
  floorUses,
  active = true,
  mode = "heat",
  exploded = false,
  xray = false,
  lowQuality = false,
  autoRotate = true,
  resetKey = 0,
  selectedFloor = null,
  onFloorClick,
}: TwinSceneViewProps) {
  const store = useContext(StoreContext);
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<TwinScene | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const activity = useRef(active);
  activity.current = active;
  const applyActivity = useRef<((active: boolean) => void) | null>(null);
  const clickHandler = useRef(onFloorClick);
  clickHandler.current = onFloorClick;

  const latest = useRef({
    frame,
    floorColorScale,
    floorUses,
    mode,
    exploded,
    xray,
    lowQuality,
    selectedFloor,
    autoRotate,
  });
  latest.current = {
    frame,
    floorColorScale,
    floorUses,
    mode,
    exploded,
    xray,
    lowQuality,
    selectedFloor,
    autoRotate,
  };
  useLayoutEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    const boot = async () => {
      // Leave React's data commit and paint unblocked by 3D initialization.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const cache = await GeometryCache.load(options);
      if (cancelled || !host.current) return;
      const initiallyActive =
        !document.hidden &&
        (store ? store.getSnapshot().page === "overview" : activity.current);
      const scene = await TwinScene.create(
        host.current,
        options,
        cache,
        initiallyActive,
      );
      if (cancelled) {
        scene.dispose();
        return;
      }
      instance.current = scene;
      if (store) {
        scene.setFrameSampler(() => {
          const data = store.getSnapshot().data;
          return data ? sampleFrame(data, store.getContinuousTime()) : null;
        });
        scene.setOpsSampler(() => {
          const state = store.getSnapshot();
          const at_ms =
            state.followingCurrent && state.playbackStartMs === null
              ? store.getRealNowMs()
              : store.getPlaybackFrame().nowMs;
          return { at_ms, day: opsTimeline.getDay(at_ms) };
        });
      }
      const unsubscribe = scene.on("floorClick", (floor) =>
        clickHandler.current?.(floor),
      );
      const p = latest.current;
      if (p.floorColorScale)
        scene.setFloorColorScale(p.floorColorScale, p.floorUses);
      scene.setFrame(p.frame);
      scene.setMode(p.mode);
      scene.setExploded(p.exploded);
      scene.setXray(p.xray);
      scene.setQuality(p.lowQuality ? "low" : "high");
      scene.selectFloor(p.selectedFloor);
      scene.setAutoRotate(p.autoRotate);
      let raf = 0;
      let running = false;
      const labelSizes = new WeakMap<
        HTMLElement,
        { text: string; width: number; height: number }
      >();
      const labels = Array.from(
        overlay.current?.querySelectorAll<HTMLElement>("[data-anchor]") ?? [],
      );
      const metricsEnabled =
        import.meta.env.DEV ||
        new URLSearchParams(location.search).has("sceneMetrics");
      let lastGeometryKey = "";
      // Wrapping changes on resize or font load even when the text is unchanged.
      const labelResize = new ResizeObserver((entries) => {
        for (const entry of entries)
          labelSizes.delete(entry.target as HTMLElement);
        lastGeometryKey = "";
      });
      for (const label of labels) labelResize.observe(label);
      const update = () => {
        if (!running) return;
        const snapshot = scene.interactionSnapshot;
        if (metricsEnabled && host.current)
          host.current.dataset.scene = JSON.stringify(snapshot);
        const geometryKey = `${snapshot.camera.join(",")}|${snapshot.target.join(",")}|${snapshot.spacing}|${scene.viewportSize.width}|${scene.viewportSize.height}|${labels.map((l) => l.textContent).join("|")}`;
        if (geometryKey === lastGeometryKey) {
          raf = requestAnimationFrame(update);
          return;
        }
        lastGeometryKey = geometryKey;
        const points = labels.map((label) => ({
          label,
          point: scene.project(
            label.dataset.anchor as "tower" | "storage" | "pv" | "grid",
          ),
        }));
        const tower = scene.projectTowerBounds();
        const positions = layoutSceneLabels(
          points
            // An offscreen projected anchor is only an ideal position, not a reason
            // to remove a required equipment label. Packing clamps it into view.
            .map(({ label, point }) => ({
              key: label.dataset.anchor!,
              x: point.x,
              y: point.y,
              width: (() => {
                let size = labelSizes.get(label);
                if (!size || size.text !== label.textContent) {
                  size = {
                    text: label.textContent ?? "",
                    width: label.offsetWidth,
                    height: label.offsetHeight,
                  };
                  labelSizes.set(label, size);
                }
                return size.width;
              })(),
              height: labelSizes.get(label)!.height,
            })),
          scene.viewportSize.width,
          scene.viewportSize.height,
          tower,
        );
        if (import.meta.env.DEV && overlay.current)
          overlay.current.dataset.towerBounds = JSON.stringify(tower);
        for (const { label } of points) {
          const rect = positions.get(label.dataset.anchor!);
          if (rect)
            label.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
          label.style.visibility = rect ? "visible" : "hidden";
        }
        raf = requestAnimationFrame(update);
      };
      const activate = (on: boolean) => {
        if (running === on && host.current?.dataset.renderActive === String(on))
          return;
        scene.setActive(on);
        if (host.current) host.current.dataset.renderActive = String(on);
        if (running === on) return;
        running = on;
        if (on) raf = requestAnimationFrame(update);
        else {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      };
      const syncActivity = () => {
        const on =
          !document.hidden &&
          (store ? store.getSnapshot().page === "overview" : activity.current);
        // Pause immediately, but resume only after React has unhidden the host.
        if (on && !running && !activity.current) return;
        activate(on);
      };
      applyActivity.current = syncActivity;
      // Route notifications are immediate: do not wait for phased React snapshots.
      const unsubscribeActivity = store?.subscribe(syncActivity);
      document.addEventListener("visibilitychange", syncActivity);
      syncActivity();
      void scene.prepare().catch(() => {
        if (host.current) host.current.dataset.sceneError = "true";
      });
      cleanup = () => {
        running = false;
        unsubscribeActivity?.();
        document.removeEventListener("visibilitychange", syncActivity);
        applyActivity.current = null;
        cancelAnimationFrame(raf);
        labelResize.disconnect();
        unsubscribe();
        scene.dispose();
        instance.current = null;
      };
    };
    void boot();
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [options, store]);

  useLayoutEffect(() => {
    applyActivity.current?.(active);
  }, [active]);

  useEffect(() => {
    instance.current?.resetView();
  }, [resetKey]);

  useEffect(() => {
    if (floorColorScale)
      instance.current?.setFloorColorScale(floorColorScale, floorUses);
    instance.current?.setFrame(frame);
  }, [frame, options, floorColorScale, floorUses]);

  useEffect(() => {
    instance.current?.setMode(mode);
    instance.current?.setExploded(exploded);
    instance.current?.setXray(xray);
    instance.current?.setQuality(lowQuality ? "low" : "high");
    instance.current?.selectFloor(selectedFloor);
    instance.current?.setAutoRotate(autoRotate);
  }, [mode, exploded, xray, lowQuality, selectedFloor, autoRotate, options]);

  return (
    <div className={`scene-wrapper ${frame.hour.abstain ? "handoff" : ""}`}>
      <div ref={host} className="twin-scene" aria-label="云栖塔三维场景">
        <span
          role="status"
          className="scene-loading"
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
          }}
        >
          三维场景加载中…
        </span>
        <style>{`.twin-scene[data-scene-ready="true"] .scene-loading{display:none!important}`}</style>
      </div>
      <div ref={overlay} className="scene-labels">
        <span data-anchor="tower">
          云栖塔{" "}
          <b className="scene-power-value">{n(frame.hour.point_kw, 1)} kW</b> ·{" "}
          <OverviewStatusText text={frame.hour.abstain
            ? `转交人工 · 置信 ${n(frame.hour.confidence * 100, 1)}%`
            : `置信 ${n(frame.hour.confidence * 100, 1)}%`} />
        </span>
        <span data-anchor="storage">
          储能站{" "}
          <b>
            <i className="scene-power-value">
              {n(Math.abs(frame.hour.storage.power_kw), 1)} kW
            </i>
            <br />
            <OverviewStatusText text={frame.hour.storage.power_kw < 0
              ? "充电"
              : frame.hour.storage.power_kw > 0
                ? "放电"
                : "待机"} />{" "}
            SOC {n(frame.hour.storage.soc * 100, 1)}%
          </b>
        </span>
        <span data-anchor="pv">
          光伏车棚{" "}
          <b className="scene-power-value">{n(frame.hour.pv.power_kw, 1)} kW</b>
        </span>
        <span data-anchor="grid">
          市电接入{" "}
          <b className="scene-power-value">{n(frame.hour.grid_kw, 1)} kW</b>
        </span>
      </div>
    </div>
  );
}
