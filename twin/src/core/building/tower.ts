import * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { BuildingSpec } from "../../data/types";
import { floorBatch } from "./floorBatch";
import type { GeometryCache } from "../geometryCache";
function createSlab(w: number, h: number) {
  const r = 0.9,
    s = new T.Shape();
  s.moveTo(-w + r, -w);
  s.lineTo(w - r, -w);
  s.quadraticCurveTo(w, -w, w, -w + r);
  s.lineTo(w, w - r);
  s.quadraticCurveTo(w, w, w - r, w);
  s.lineTo(-w + r, w);
  s.quadraticCurveTo(-w, w, -w, w - r);
  s.lineTo(-w, -w + r);
  s.quadraticCurveTo(-w, -w, -w + r, -w);
  const g = new T.ExtrudeGeometry(s, {
    depth: h,
    bevelEnabled: false,
    curveSegments: 5,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}
function* buildTower(spec: BuildingSpec, cache?: GeometryCache) {
  const slab = (w: number, h: number) =>
    cache?.get(`slab:${w}:${h}`, () => createSlab(w, h)) ?? createSlab(w, h);
  const root = new T.Group(),
    floors: T.Group[] = [],
    glass: T.MeshStandardMaterial[] = [];
  const metal = new T.MeshStandardMaterial({
    color: 0x6d8d99,
    metalness: 0.7,
    roughness: 0.32,
  });
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#080d13";
  ctx.fillRect(0, 0, 128, 64);
  for (let x = 4; x < 128; x += 12)
    for (let y = 8; y < 64; y += 22) {
      ctx.fillStyle = (x + y) % 5 ? "#a0b4b8" : "#16222b";
      ctx.fillRect(x, y, 7, 14);
    }
  const windowTexture = new T.CanvasTexture(canvas);
  windowTexture.colorSpace = T.SRGBColorSpace;
  const treeMaterial = new T.MeshStandardMaterial({
    color: 0x2b6553,
    roughness: 1,
  });
  for (let i = 0; i < spec.floors; i++) {
    const f = new T.Group(),
      p = i / Math.max(1, spec.floors - 1),
      w =
        spec.baseWidth +
        (spec.topWidth - spec.baseWidth) * p ** spec.taperExponent,
      garden = spec.gardenFloors.includes(i + 1);
    f.position.y = 6 + i * 1.3;
    f.rotation.y = (p * spec.twistDeg * Math.PI) / 180;
    f.userData.floor = i;
    const edge = new T.Mesh(slab(w, 0.16), metal);
    edge.castShadow = true;
    f.add(edge);
    const mat = new T.MeshStandardMaterial({
      color: 0x326778,
      metalness: 0.4,
      roughness: 0.28,
      emissive: 0x123344,
      emissiveMap: windowTexture,
    });
    glass.push(mat);
    const window = new T.Mesh(slab(w - (garden ? 1.2 : 0.12), 1.05), mat);
    window.position.y = 0.16;
    window.userData.floor = i;
    f.add(window);
    if (!garden) {
      // Glass face is inset 0.12 from the slab. Keep all 12 frames per straight
      // edge inside the radius-0.9 tangency points; no floating corner frames.
      const face = w - 0.12,
        straight = face - 0.9;
      const generateFrames = () => {
        const pieces: T.BufferGeometry[] = [];
        for (let j = 0; j < 48; j++) {
          const side = Math.floor(j / 12),
            u = (((j % 12) + 0.5) / 12) * 2 * straight - straight;
          const x =
              side === 0 ? u : side === 1 ? face : side === 2 ? -u : -face,
            z = side === 0 ? -face : side === 1 ? u : side === 2 ? face : -u;
          const geo = new T.BoxGeometry(0.07, 1.05, 0.07);
          geo.translate(x, 0.16 + 1.05 / 2, z);
          pieces.push(geo);
        }
        const merged = mergeGeometries(pieces)!;
        pieces.forEach((g) => g.dispose());
        return merged;
      };
      const frames = new T.Mesh(
        cache?.get(`mullions:${w}`, generateFrames) ?? generateFrames(),
        metal,
      );
      frames.name = "glass-mullions";
      f.add(frames);
    }
    if (garden) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2,
          tree = new T.Mesh(new T.ConeGeometry(0.45, 1.5, 6), treeMaterial);
        tree.position.set(
          Math.cos(a) * (w - 0.5),
          0.9,
          Math.sin(a) * (w - 0.5),
        );
        f.add(tree);
      }
    }
    root.add(f);
    floors.push(f);
    yield;
  }
  for (let i = 0; i < 3; i++) {
    const m = new T.Mesh(slab(11 - i * 0.5, 1.7), metal);
    m.position.y = i * 1.8;
    root.add(m);
  }
  const roof = new T.Mesh(slab(9.8, 0.15), treeMaterial);
  roof.position.y = 5.5;
  root.add(roof);
  const canopy = new T.Mesh(new T.BoxGeometry(9, 0.15, 5), metal);
  canopy.position.set(0, 2.7, 12);
  root.add(canopy);
  const crown = new T.Group();
  crown.position.y = 6 + spec.floors * 1.3;
  crown.rotation.y = floors.at(-1)!.rotation.y;
  const crownBase = new T.Mesh(slab(spec.topWidth, 0.16), metal);
  crownBase.name = "crown-base";
  crown.add(crownBase);
  const alarmMat = new T.MeshStandardMaterial({
    color: 0x4fd1d9,
    emissive: 0x4fd1d9,
    emissiveIntensity: 1.5,
  });
  for (let i = 0; i < 5; i++) {
    const ring = new T.Mesh(
      new T.TorusGeometry(spec.topWidth - i * 0.65, 0.08, 8, 64),
      alarmMat,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = i * 0.8;
    ring.name = "crown-ring";
    crown.add(ring);
    const fin = new T.Mesh(
      slab(Math.max(1, spec.topWidth - i * 0.65), 0.08),
      new T.MeshPhysicalMaterial({
        color: 0x76c3d1,
        transparent: true,
        opacity: 0.3,
        metalness: 0.6,
        roughness: 0.25,
      }),
    );
    fin.position.y = i * 0.8;
    fin.name = "crown-fin";
    fin.rotation.y = 0;
    crown.add(fin);
  }
  const spire = new T.Mesh(new T.CylinderGeometry(0.06, 0.2, 5, 8), metal);
  spire.name = "crown-spire";
  spire.position.y = 5;
  crown.add(spire);
  const beacon = new T.Mesh(
    new T.SphereGeometry(0.18, 8, 8),
    new T.MeshBasicMaterial({ color: 0xff4d5e }),
  );
  beacon.position.y = 7.5;
  crown.add(beacon);
  root.add(crown);
  const core = new T.Mesh(
    new T.BoxGeometry(2.4, spec.floors * 1.3, 2.4),
    new T.MeshStandardMaterial({ color: 0x283b4a, roughness: 0.8 }),
  );
  core.position.y = 6 + (spec.floors * 1.3) / 2;
  root.add(core);
  const cars = Array.from({ length: 6 }, (_, index) => {
    const car = new T.Mesh(
      new T.BoxGeometry(0.75, 0.95, 0.8),
      new T.MeshStandardMaterial({
        color: index < 3 ? 0x4fd1d9 : 0x7aa7ff,
        emissive: index < 3 ? 0x4fd1d9 : 0x7aa7ff,
        emissiveIntensity: 0.8,
      }),
    );
    car.position.set(((index % 3) - 1) * 1.05, 6, index < 3 ? 1.8 : -1.8);
    root.add(car);
    return car;
  });
  const halo = new T.Mesh(
    new T.CylinderGeometry(
      spec.baseWidth + 2,
      spec.baseWidth + 2,
      spec.floors * 1.3 + 6,
      64,
      1,
      true,
    ),
    new T.MeshBasicMaterial({
      color: 0xff4d5e,
      transparent: true,
      opacity: 0.06,
      side: T.DoubleSide,
      depthWrite: false,
      blending: T.AdditiveBlending,
    }),
  );
  halo.position.y = 6 + (spec.floors * 1.3) / 2;
  halo.visible = false;
  root.add(halo);
  const outlineMaterial = new T.LineBasicMaterial({
    color: 0xff4d5e,
    transparent: true,
    opacity: 0.8,
  });
  const outlines: T.LineSegments[] = [];
  for (const f of floors) {
    const mesh = f.children[0] as T.Mesh;
    const line = new T.LineSegments(
      cache?.get(
        `outline:${f.userData.floor}`,
        () => new T.EdgesGeometry(mesh.geometry),
      ) ?? new T.EdgesGeometry(mesh.geometry),
      outlineMaterial,
    );
    line.visible = false;
    f.add(line);
    outlines.push(line);
    yield;
  }
  const batch = floorBatch(root, floors, glass, metal, cache);
  return {
    batch,
    root,
    floors,
    glass,
    crown,
    alarmMat,
    beacon,
    outlines,
    outlineMaterial,
    core,
    cars,
    halo,
    metal,
  };
}

/** Synchronous entry retained for geometry tests and offline scene tooling. */
export function tower(spec: BuildingSpec, cache?: GeometryCache) {
  const iterator = buildTower(spec, cache);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}
export async function towerAsync(spec: BuildingSpec, cache?: GeometryCache) {
  const iterator = buildTower(spec, cache);
  let step = iterator.next(),
    slice = performance.now();
  while (!step.done) {
    if (performance.now() - slice > 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      slice = performance.now();
    }
    step = iterator.next();
  }
  return step.value;
}
