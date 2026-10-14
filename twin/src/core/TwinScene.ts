import * as T from "three";
import type { GeometryCache } from "./geometryCache";
import { observeSize } from "../components/observeSize";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { tower, towerAsync } from "./building/tower";
import { world } from "./environment/world";
import { energy } from "./energy/energy";
import { postfx } from "./postfx";
import { qualityPixelRatio, watchDevicePixelRatio } from "./pixelRatio";
import { daylight, heatColor, normalize } from "./palette";
import { sceneElevators, type SceneOpsFrame } from "./elevators";
import type { OpsElevatorState } from "../data/ops";
import { opsFloorScale, sampleOpsFloorLoads } from "../data/ops/floorColors";
import {
  floorColor,
  EQUIPMENT_COLOR,
  type FloorColorScale,
} from "../ui/floorColors";
import { RotationPolicy } from "./rotation";
import { blend, constrainTarget } from "./transitions";
import type { BuildingSpec, TwinFrame } from "../data/types";
export interface TwinSceneOptions {
  building: BuildingSpec;
  campusCount?: number;
  quality?: "high" | "low";
}
export class TwinScene {
  static async create(
    container: HTMLElement,
    options: TwinSceneOptions,
    cache?: GeometryCache,
    initiallyActive = true,
  ) {
    const started = performance.now();
    const building = await towerAsync(options.building, cache);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const scene = new TwinScene(
      container,
      options,
      cache,
      initiallyActive,
      building,
    );
    scene.buildStarted = started;
    return scene;
  }
  private buildStarted = performance.now();
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(36, 1, 0.5, 1800);
  private renderer = new T.WebGLRenderer({ antialias: true });
  private controls: OrbitControls;
  private rotation = new RotationPolicy();
  private building;
  private env;
  private energy;
  private fx;
  private stopSize: () => void;
  private stopPixelRatio: () => void;
  private quality: "high" | "low" = "high";
  private lastSize = { width: 0, height: 0, ratio: 0 };
  private pmrem!: T.PMREMGenerator;
  private envTarget!: T.WebGLRenderTarget;
  private sun = new T.DirectionalLight(0xffe5bf, 3);
  private ambient = new T.HemisphereLight(0x91bace, 0x14202c, 1);
  private frame?: TwinFrame;
  private campusHour = -1;
  private frameSampler: (() => TwinFrame | null) | null = null;
  setFrameSampler(sampler: () => TwinFrame | null) {
    this.frameSampler = sampler;
  }
  private floorScale: FloorColorScale = { p10: 0, p50: 45, p90: 90 };
  private floorUses: readonly string[] = [];
  private opsFloorLoads: readonly number[] | null = null;
  setFloorColorScale(
    scale: FloorColorScale,
    floorUses: readonly string[] = [],
  ) {
    this.floorScale = scale;
    this.floorUses = floorUses;
    this.paint();
  }
  private visualHour = 14;
  private targetHour = 14;
  private lastTick = performance.now();
  private opsSampler: (() => SceneOpsFrame) | null = null;
  setOpsSampler(sampler: () => SceneOpsFrame) {
    this.opsSampler = sampler;
  }
  private opsAtMs: number | null = null;
  private opsAvailable = false;
  private elevatorStates: OpsElevatorState[] = [];
  private targetColors: T.Color[] = [];
  private mode: "heat" | "real" = "heat";
  private exploded = false;
  private spacing = 1.3;
  private cameraGoal: { position: T.Vector3; target: T.Vector3 } | null = null;
  private targetPower = [0, 0, 0];
  private flowPhase = [0, 0, 0];
  private xray = false;
  private selected: number | null = null;
  private handlers = {
    floorClick: new Set<(x: number) => void>(),
    campusClick: new Set<(x: number) => void>(),
  };
  private raf = 0;
  private active = true;
  private pausedAt = 0;
  private disposed = false;
  private ray = new T.Raycaster();
  private pointer = new T.Vector2();
  private tmp = new T.Vector3();
  private color = new T.Color();
  private fogColor = new T.Color();
  private power = [0, 0, 0];
  private litMaterials = new Set<T.MeshStandardMaterial>();
  private geometryVertices = 0;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private started = performance.now();
  private down = { x: 0, y: 0 };
  constructor(
    private container: HTMLElement,
    options: TwinSceneOptions,
    private geometryCache?: GeometryCache,
    initiallyActive = true,
    building?: ReturnType<typeof tower>,
  ) {
    // Opt-in diagnostics in development; production never synchronously queries
    // LINK_STATUS for every program on the first visible frame.
    this.renderer.debug.checkShaderErrors =
      import.meta.env.DEV &&
      new URLSearchParams(location.search).has("shaderDebug");
    this.renderer.domElement.style.visibility = "hidden";
    this.renderer.toneMapping = T.NoToneMapping;
    this.renderer.outputColorSpace = T.LinearSRGBColorSpace;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "参数化云栖塔，可拖动旋转，点击楼层",
    );
    container.append(this.renderer.domElement);
    this.camera.position.set(88, 58, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 30, 0);
    this.controls.enableDamping = true;
    this.controls.addEventListener("start", this.interactionStart);
    this.controls.addEventListener("end", this.interactionEnd);
    this.controls.autoRotate = !this.reduced.matches;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.maxDistance = 400;
    this.controls.minDistance = 30;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.06;
    this.building = building ?? tower(options.building, geometryCache);
    this.env = world(options.campusCount ?? 150);
    this.energy = energy(geometryCache);
    this.scene.add(
      this.building.root,
      this.env.group,
      this.energy.group,
      this.sun,
      this.ambient,
    );
    this.scene.traverse((object) => {
      const geometry = (object as T.Mesh).geometry;
      if (geometry)
        this.geometryVertices += geometry.getAttribute("position").count;
      const material = (object as T.Mesh).material;
      if (material)
        (Array.isArray(material) ? material : [material]).forEach((m) => {
          if (m instanceof T.MeshStandardMaterial) this.litMaterials.add(m);
        });
    });
    // Static transforms do not need hundreds of matrix multiplications every render.
    this.scene.updateMatrixWorld(true);
    const dynamic = new Set<T.Object3D>([
      this.building.crown,
      this.building.core,
      this.building.halo,
      this.building.beacon,
      this.env.traffic,
      ...this.building.floors,
      ...this.building.cars,
    ]);
    this.scene.traverse((object) => {
      if (object instanceof T.Mesh && !dynamic.has(object))
        object.matrixAutoUpdate = false;
    });
    this.building.floors.forEach((floor) => (floor.matrixAutoUpdate = false));
    this.scene.matrixAutoUpdate = false;
    this.building.root.matrixAutoUpdate = false;
    this.env.group.matrixAutoUpdate = false;
    this.energy.group.matrixAutoUpdate = false;
    this.scene.fog = new T.FogExp2(0x102331, 0.0025);
    this.sun.position.set(70, 100, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, {
      left: -80,
      right: 80,
      top: 90,
      bottom: -80,
      far: 300,
    });
    // Environment rendering is deferred until its shaders have compiled.
    this.fx = postfx(this.renderer, this.scene, this.camera);
    this.stopSize = observeSize(container, () => this.resize());
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.renderer.domElement.addEventListener(
      "webglcontextrestored",
      this.contextRestored,
    );
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.click);
    this.reduced.addEventListener("change", this.motion);
    this.setQuality(options.quality ?? "high");
    this.stopPixelRatio = watchDevicePixelRatio(() =>
      this.setQuality(this.quality),
    );
    this.resize();
    if (!initiallyActive) this.setActive(false);
    performance.measure("twin:construct", {
      start: this.buildStarted,
      end: performance.now(),
    });
    geometryCache?.save();
  }
  setFrame(frame: TwinFrame) {
    const initial = !this.frame;
    this.frame = frame;
    this.targetHour = frame.hourIndex;
    if (initial) this.visualHour = this.targetHour;
    this.targetPower[0] = frame.hour.storage.power_kw;
    this.targetPower[1] = frame.hour.pv.power_kw;
    this.targetPower[2] = frame.hour.grid_kw;
    this.paint();
    if (initial)
      this.building.glass.forEach((m, i) => m.color.copy(this.targetColors[i]));
    if (initial || Math.floor(frame.hourIndex) !== this.campusHour) {
      this.campusHour = Math.floor(frame.hourIndex);
      frame.campus.slice(0, this.env.city.count).forEach((b, i) => {
        this.color.setHex(
          b.abstain ? 0xff4d5e : heatColor(normalize(b.point_kw ?? 0, 300)),
        );
        this.env.city.setColorAt(i, this.color);
      });
      if (this.env.city.instanceColor)
        this.env.city.instanceColor.needsUpdate = true;
    }
  }
  private updateLighting() {
    const hour = ((this.visualHour % 24) + 24) % 24;
    const d = daylight(hour);
    this.sun.intensity = d * 3;
    this.sun.position.set(
      Math.cos(((hour - 6) / 12) * Math.PI) * 100,
      Math.max(2, d * 120),
      40,
    );
    this.ambient.intensity = 0.12 + d * 0.55;
    this.scene.environmentIntensity = 1;
    // Cache material identities: lighting changes every frame, scene topology does not.
    this.litMaterials.forEach((m) => {
      m.envMapIntensity = 0.14 + d * 0.64;
    });
    this.fx.bloom.strength = 0.2 + (1 - d) * 0.18;
    const sky = this.env.sky.material as T.ShaderMaterial;
    sky.uniforms.top.value.setRGB(
      0.01 + d * 0.13,
      0.025 + d * 0.3,
      0.06 + d * 0.45,
    );
    sky.uniforms.bottom.value.setRGB(
      0.003 + d * 0.055,
      0.009 + d * 0.09,
      0.02 + d * 0.14,
    );
    this.fogColor.copy(sky.uniforms.bottom.value);
    (this.scene.fog as T.FogExp2).color.copy(this.fogColor);
    this.env.material.emissiveIntensity = (1 - d) * 0.7;
    if (
      this.frameSampler ||
      Math.abs(this.visualHour - this.targetHour) > 0.001
    )
      this.renderer.shadowMap.needsUpdate = true;
  }
  private paint() {
    if (!this.frame) return;
    const metalChanged = this.building.metal.transparent !== this.xray;
    this.building.metal.transparent = this.xray;
    this.building.metal.opacity = this.xray ? 0.16 : 1;
    this.building.metal.depthWrite = !this.xray;
    if (metalChanged) this.building.metal.needsUpdate = true;
    this.building.glass.forEach((m, i) => {
      const target =
        this.targetColors[i] ?? (this.targetColors[i] = new T.Color());
      target.setHex(
        this.floorUses[i] === "equipment"
          ? Number.parseInt(EQUIPMENT_COLOR.slice(1), 16)
          : this.frame!.hour.abstain
            ? 0xe66b78
            : this.mode === "heat"
              ? Number.parseInt(
                  floorColor(
                    this.opsFloorLoads?.[i] ?? NaN,
                    this.floorScale,
                    this.floorUses[i],
                  ).slice(1),
                  16,
                )
              : 0x326778,
      );
      m.emissive.copy(m.color);
      const transparent =
        this.xray || (this.selected !== null && this.selected !== i);
      const materialChanged = m.transparent !== transparent;
      m.transparent =
        this.xray || (this.selected !== null && this.selected !== i);
      m.opacity = this.xray ? 0.12 : m.transparent ? 0.15 : 1;
      m.depthWrite = !m.transparent;
      if (materialChanged) m.needsUpdate = true;
    });
    this.building.alarmMat.color.setHex(
      this.frame.hour.abstain ? 0xff4d5e : 0x4fd1d9,
    );
    this.building.alarmMat.emissive.copy(this.building.alarmMat.color);
    this.building.halo.visible = this.frame.hour.abstain;
  }
  setXray(on: boolean) {
    this.xray = on;
    this.paint();
  }
  setMode(mode: "heat" | "real") {
    this.mode = mode;
    this.paint();
  }
  setExploded(on: boolean) {
    if (this.exploded === on) return;
    this.exploded = on;
    this.resetView();
  }
  selectFloor(index: number | null) {
    if (this.selected !== index) {
      this.selected = index;
      if (index === null) this.resetView();
      else {
        const target = new T.Vector3(
          0,
          6 + index * (this.exploded ? 2.4 : 1.3),
          0,
        );
        const offset = this.camera.position
          .clone()
          .sub(this.controls.target)
          .normalize()
          .multiplyScalar(65);
        this.cameraGoal = { target, position: target.clone().add(offset) };
      }
    }
    this.paint();
  }
  resetView() {
    this.rotation.reset();
    this.cameraGoal = {
      position: new T.Vector3(88, 58, 100).multiplyScalar(
        this.exploded ? 1.45 : 1,
      ),
      target: new T.Vector3(0, this.exploded ? 48 : 30, 0),
    };
  }
  setAutoRotate(on: boolean) {
    this.rotation.enabled = on;
    this.refreshRotation();
  }
  setQuality(q: "high" | "low") {
    this.quality = q;
    const ratio = qualityPixelRatio(window.devicePixelRatio, q);
    this.renderer.setPixelRatio(ratio);
    this.fx.composer.setPixelRatio(ratio);
    this.renderer.shadowMap.enabled = q === "high";
    this.fx.bloom.enabled = q === "high";
    this.renderer.shadowMap.needsUpdate = true;
    this.resize();
  }
  on(event: "floorClick" | "campusClick", handler: (payload: number) => void) {
    this.handlers[event].add(handler);
    return () => {
      this.handlers[event].delete(handler);
    };
  }
  get viewportSize() {
    return this.lastSize;
  }
  project(anchor: "storage" | "pv" | "grid" | "tower") {
    this.tmp.copy(this.energy.anchors[anchor]).project(this.camera);
    return {
      x: ((this.tmp.x + 1) * this.lastSize.width) / 2,
      y: ((1 - this.tmp.y) * this.lastSize.height) / 2,
      visible:
        this.tmp.z > -1 &&
        this.tmp.z < 1 &&
        Math.abs(this.tmp.x) < 1 &&
        Math.abs(this.tmp.y) < 1,
    };
  }
  /** Conservative screen-space tower silhouette, reserved for readable overlays. */
  projectTowerBounds() {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    const crown = 6 + this.building.floors.length * this.spacing + 8;
    for (const x of [-9, 9])
      for (const z of [-9, 9])
        for (const y of [6, crown]) {
          this.tmp.set(x, y, z).project(this.camera);
          const px = ((this.tmp.x + 1) * this.lastSize.width) / 2;
          const py = ((1 - this.tmp.y) * this.lastSize.height) / 2;
          left = Math.min(left, px);
          right = Math.max(right, px);
          top = Math.min(top, py);
          bottom = Math.max(bottom, py);
        }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  resize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight;
    if (!w || !h) {
      this.lastSize.width = this.lastSize.height = 0;
      return;
    }
    const ratio = this.renderer.getPixelRatio();
    if (
      w === this.lastSize.width &&
      h === this.lastSize.height &&
      ratio === this.lastSize.ratio
    )
      return;
    this.lastSize = { width: w, height: h, ratio };
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.fx.composer.setSize(w, h);
  }
  private pointerDown = (e: PointerEvent) => {
    this.cameraGoal = null;
    this.down.x = e.clientX;
    this.down.y = e.clientY;
  };
  private click = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5)
      return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      (-(e.clientY - r.top) / r.height) * 2 + 1,
    );
    this.ray.setFromCamera(this.pointer, this.camera);
    this.building.floors.forEach((floor) =>
      floor.updateWorldMatrix(true, true),
    );
    const hits = this.ray.intersectObjects(
      [...this.building.floors, this.env.city],
      true,
    );
    if (hits.length) {
      const hit = hits[0];
      if (hit.object === this.env.city) {
        this.handlers.campusClick.forEach((fn) => fn(hit.instanceId!));
        return;
      }
      let obj: T.Object3D | null = hit.object;
      while (obj && obj.userData.floor === undefined) obj = obj.parent;
      if (obj)
        this.handlers.floorClick.forEach((fn) => fn(obj!.userData.floor));
    }
  };
  private refreshRotation = () => {
    this.controls.autoRotate = this.rotation.active(
      performance.now(),
      this.reduced.matches,
      this.cameraGoal !== null,
    );
  };
  private interactionStart = () => {
    this.cameraGoal = null;
    this.rotation.start();
    this.refreshRotation();
  };
  private interactionEnd = () => {
    this.rotation.end(performance.now());
    this.refreshRotation();
  };
  private motion = () => {
    this.refreshRotation();
  };
  setActive(active: boolean) {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (!active) {
      this.pausedAt = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.stopSize();
      this.renderer.domElement.remove();
    } else {
      const now = performance.now();
      this.started += now - this.pausedAt;
      this.lastTick = now;
      this.container.append(this.renderer.domElement);
      this.stopSize = observeSize(this.container, () => this.resize());
      this.resize();
      if (this.contextRestorePending) {
        this.rebuildContext();
        void this.prepare();
      }
      if (this.prepared && !this.contextUnavailable) this.animate();
    }
  }
  private contextUnavailable = false;
  private contextRestores = 0;
  private contextLost = (event: Event) => {
    event.preventDefault();
    this.contextUnavailable = true;
    this.prepared = false;
    ++this.preparation;
    this.container.dataset.sceneReady = "false";
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  };
  private contextRestorePending = false;
  private contextRestored = () => {
    if (this.disposed) return;
    this.contextRestorePending = true;
    if (this.active) {
      this.rebuildContext();
      void this.prepare();
    }
  };
  private rebuildContext() {
    this.contextRestorePending = false;
    this.fx.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    // Environment rendering is deferred until its shaders have compiled.
    this.fx = postfx(this.renderer, this.scene, this.camera);
    this.lastSize = { width: 0, height: 0, ratio: 0 };
    this.setQuality(this.quality);
    this.contextUnavailable = false;
    this.contextRestores++;
    this.lastTick = performance.now();
  }
  private prepared = false;
  private preparation = 0;
  async prepare() {
    const generation = ++this.preparation;
    this.renderer.domElement.style.visibility = "hidden";
    const compiled = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (
      this.disposed ||
      this.contextUnavailable ||
      generation !== this.preparation
    )
      return;
    const room = new RoomEnvironment();
    await this.renderer.compileAsync(
      room,
      new T.PerspectiveCamera(90, 1, 0.1, 100),
    );
    if (
      this.disposed ||
      this.contextUnavailable ||
      generation !== this.preparation
    ) {
      room.dispose();
      return;
    }
    this.pmrem = new T.PMREMGenerator(this.renderer);
    this.envTarget = this.pmrem.fromScene(room, 0.04);
    room.dispose();
    this.scene.environment = this.envTarget.texture;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (
      this.disposed ||
      this.contextUnavailable ||
      generation !== this.preparation
    )
      return;
    this.building.batch.update(this.spacing, this.selected);
    this.updateLighting();
    // Shadow depth variants otherwise compile synchronously in the first render.
    const depths = new T.Scene();
    this.scene.traverse((object) => {
      if (!(object instanceof T.Mesh) || !object.castShadow) return;
      const material =
        object.customDepthMaterial ??
        new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
      object.customDepthMaterial = material;
      const proxy =
        object instanceof T.InstancedMesh
          ? new T.InstancedMesh(object.geometry, material, object.count)
          : new T.Mesh(object.geometry, material);
      depths.add(proxy);
    });
    await this.renderer.compileAsync(
      depths,
      this.sun.shadow.camera,
      this.scene,
    );
    depths.traverse((object) => {
      if (object instanceof T.InstancedMesh) object.dispose();
    });
    await this.renderer.compileAsync(this.scene, this.camera);
    await this.fx.compileAsync();
    if (
      this.disposed ||
      this.contextUnavailable ||
      generation !== this.preparation
    )
      return;
    this.prepared = true;
    performance.measure("twin:compile", {
      start: compiled,
      end: performance.now(),
    });
    if (this.active) this.animate();
  }
  private renderedAt = 0;
  private frameCost = { cpu: 0, render: 0 };
  private animate = () => {
    if (
      this.disposed ||
      !this.active ||
      this.contextUnavailable ||
      !this.prepared
    )
      return;
    this.raf = requestAnimationFrame(this.animate);
    if (!this.lastSize.width || !this.lastSize.height) this.resize();
    const t = (performance.now() - this.started) / 1000;
    const now = performance.now();
    const elapsed = Math.max(0, (now - this.lastTick) / 1000);
    const alpha = blend(Math.min(elapsed, 0.1));
    this.lastTick = now;
    const ops = this.opsSampler?.();
    this.opsFloorLoads = ops?.day ? sampleOpsFloorLoads(ops.day, ops.at_ms) : null;
    if (ops?.day) {
      this.floorScale = opsFloorScale(ops.day);
      this.floorUses = ops.day.hours[0].floors.map(floor => floor.use);
    }
    const continuous = this.frameSampler?.();
    if (continuous) {
      this.setFrame(continuous);
      this.visualHour = continuous.hourIndex; // No delayed hour transition, including 23→00.
    } else this.visualHour += (this.targetHour - this.visualHour) * alpha;
    this.power.forEach(
      (p, i) => (this.power[i] = p + (this.targetPower[i] - p) * alpha),
    );
    this.spacing += ((this.exploded ? 2.4 : 1.3) - this.spacing) * alpha;
    this.building.floors.forEach((floor, i) => {
      const y = 6 + i * this.spacing;
      if (Math.abs(floor.position.y - y) > 1e-6) {
        floor.position.y = y;
        floor.updateMatrix();
      }
    });
    const height = this.building.floors.length * this.spacing;
    this.building.crown.position.y = 6 + height;
    this.building.core.scale.y = this.spacing / 1.3;
    this.building.core.position.y = 6 + height / 2;
    this.building.halo.scale.y = this.spacing / 1.3;
    this.building.halo.position.y = 6 + height / 2;
    this.energy.anchors.tower.y = this.building.crown.position.y + 9;
    if (this.cameraGoal) {
      this.camera.position.lerp(this.cameraGoal.position, alpha);
      this.controls.target.lerp(this.cameraGoal.target, alpha);
      if (
        this.camera.position.distanceTo(this.cameraGoal.position) < 0.02 &&
        this.controls.target.distanceTo(this.cameraGoal.target) < 0.02
      )
        this.cameraGoal = null;
    }
    this.updateLighting();
    this.building.glass.forEach((m, i) => {
      if (this.targetColors[i]) m.color.lerp(this.targetColors[i], alpha);
      m.emissive.copy(m.color);
      const day = daylight(((this.visualHour % 24) + 24) % 24);
      const highlighted = this.selected === i && day > 0.05;
      if (this.xray) m.opacity = highlighted ? 0.65 : 0.12;
      m.emissiveIntensity = highlighted ? 0.8 + day * 0.7 : (1 - day) * 0.65;
      this.building.outlines[i].visible = highlighted;
    });
    this.building.outlineMaterial.color.setHex(0x93f5ff);
    this.refreshRotation();
    this.controls.enableDamping = this.cameraGoal === null;
    this.controls.update();
    const bounded = constrainTarget(this.controls.target);
    this.tmp.set(bounded.x, bounded.y, bounded.z).sub(this.controls.target);
    this.controls.target.add(this.tmp);
    this.camera.position.add(this.tmp);
    this.camera.position.y = Math.max(1, this.camera.position.y);
    this.building.alarmMat.emissiveIntensity = this.frame?.hour.abstain
      ? this.reduced.matches
        ? 1.5
        : 1.2 + Math.sin(t * 5) * 0.7
      : 0.8;
    this.building.outlineMaterial.opacity = 1;
    this.building.beacon.visible = this.reduced.matches || Math.sin(t * 3) > 0;
    const pulse = this.reduced.matches ? 0.65 : 0.5 + Math.sin(t * 4) * 0.18;
    if (this.frame?.hour.abstain) {
      this.building.glass.forEach((m) => {
        m.emissiveIntensity = pulse;
      });
      (this.building.halo.material as T.MeshBasicMaterial).opacity =
        pulse * 0.15;
    }
    this.building.batch.update(this.spacing, this.selected);
    this.opsAtMs = ops?.at_ms ?? null;
    this.opsAvailable = !!ops?.day;
    this.elevatorStates = sceneElevators(ops?.day ?? null, ops?.at_ms ?? 0);
    this.building.cars.forEach((car, i) => {
      const state = this.elevatorStates[i];
      car.position.y = 6 + (state.floor - 1) * this.spacing + 0.65;
    });
    {
      const flowTime = this.reduced.matches ? 0 : t;
      const delta = this.reduced.matches ? 0 : -Math.log(1 - alpha) / 5;
      this.power.forEach((p, i) => {
        this.flowPhase[i] +=
          delta *
          (0.035 + Math.min(Math.abs(p), 1300) / 5000) *
          (i === 0 && p < 0 ? 1 : -1);
      });
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 7; j++) {
          const p = this.power[i];
          this.energy.dots[i][j].visible = Math.abs(p) > 1;
          let u = (this.flowPhase[i] + j / 7) % 1;
          if (u < 0) u++;
          this.energy.curves[i].getPoint(u, this.energy.dots[i][j].position);
          this.energy.dots[i][j].scale.setScalar(
            Math.min(2, 0.5 + Math.abs(p) / 600),
          );
        }
      this.energy.syncDots();
      this.env.traffic.position.z = (flowTime * 5) % 30;
    }
    this.renderer.info.reset();
    const rendering = performance.now();
    this.fx.composer.render();
    const first = !this.renderedAt;
    this.renderedAt = performance.now();
    if (first)
      performance.measure("twin:build", {
        start: this.buildStarted,
        end: this.renderedAt,
      });
    this.renderer.domElement.style.visibility = "visible";
    this.container.dataset.sceneReady = "true";
    this.frameCost = {
      cpu: rendering - now,
      render: this.renderedAt - rendering,
    };
  };
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.preparation;
    cancelAnimationFrame(this.raf);
    this.stopSize();
    this.stopPixelRatio();
    this.reduced.removeEventListener("change", this.motion);
    this.renderer.domElement.removeEventListener(
      "pointerdown",
      this.pointerDown,
    );
    this.renderer.domElement.removeEventListener("pointerup", this.click);
    this.controls.removeEventListener("start", this.interactionStart);
    this.controls.removeEventListener("end", this.interactionEnd);
    this.controls.dispose();
    const geometries = new Set<T.BufferGeometry>(),
      materials = new Set<T.Material>(),
      textures = new Set<T.Texture>();
    this.scene.traverse((obj) => {
      const m = obj as T.Mesh;
      if (m instanceof T.InstancedMesh) m.dispose();
      if (m.geometry) geometries.add(m.geometry);
      if (m.customDepthMaterial) materials.add(m.customDepthMaterial);
      if (m.material)
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((a) =>
          materials.add(a),
        );
    });
    materials.forEach((m) => {
      Object.values(m).forEach((v) => {
        if (v instanceof T.Texture) textures.add(v);
      });
      m.dispose();
    });
    geometries.forEach((g) => g.dispose());
    textures.forEach((t) => t.dispose());
    this.fx.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.renderer.domElement.removeEventListener(
      "webglcontextrestored",
      this.contextRestored,
    );
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.handlers.floorClick.clear();
    this.handlers.campusClick.clear();
  }
  get diagnostics() {
    return this.renderer.info.memory;
  }
  /** Read-only development telemetry for browser regression tests. */
  get interactionSnapshot() {
    this.tmp.copy(this.building.floors[19].position).project(this.camera);
    return {
      active: this.active,
      renderedAt: this.renderedAt,
      contextUnavailable: this.contextUnavailable,
      contextRestores: this.contextRestores,
      geometryCacheHits: this.geometryCache?.hits ?? 0,
      geometryVertices: this.geometryVertices,
      parallelCompile: this.renderer.extensions.has(
        "KHR_parallel_shader_compile",
      ),
      checkShaderErrors: this.renderer.debug.checkShaderErrors,
      frameCost: this.frameCost,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      visualHour: this.visualHour,
      sunDirection: this.sun.position.toArray(),
      renderQuality: {
        pixelRatio: this.renderer.getPixelRatio(),
        quality: this.quality,
        shadows: this.renderer.shadowMap.enabled,
        shadowMapSize: this.sun.shadow.mapSize.toArray(),
        canvasSize: [
          this.renderer.domElement.width,
          this.renderer.domElement.height,
        ],
        targetSize: [
          this.fx.composer.renderTarget1.width,
          this.fx.composer.renderTarget1.height,
        ],
        targetSamples: [
          this.fx.composer.renderTarget1.samples,
          this.fx.composer.renderTarget2.samples,
        ],
      },
      camera: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      transitioning: this.cameraGoal !== null,
      rotating: this.controls.autoRotate,
      spacing: this.spacing,
      mode: this.mode,
      xray: this.xray,
      selected: this.selected,
      glassOpacity: this.building.glass[0].opacity,
      color: this.building.glass[0].color.getHex(),
      floorColorScale: this.floorScale,
      floorActualLoads: this.opsFloorLoads,
      floorTargetColors: this.targetColors.map((color) => color.getHexString()),
      opsAtMs: this.opsAtMs,
      opsAvailable: this.opsAvailable,
      elevators: this.elevatorStates.map((state, i) => ({
        ...state,
        y: this.building.cars[i].position.y,
      })),
      crownAngle: this.building.crown.rotation.y,
      floorAngle: this.building.floors.at(-1)!.rotation.y,
      crownParts: this.building.crown.children
        .filter((object) =>
          ["crown-base", "crown-fin", "crown-ring"].includes(object.name),
        )
        .map((object) => this.building.crown.rotation.y + object.rotation.y),
      spireCenter: this.building.crown.children
        .find((object) => object.name === "crown-spire")!
        .position.toArray(),
      floorPoint: {
        x: ((this.tmp.x + 1) * this.lastSize.width) / 2,
        y: ((1 - this.tmp.y) * this.lastSize.height) / 2,
      },
    };
  }
}
