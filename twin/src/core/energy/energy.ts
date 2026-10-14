import * as T from "three";
import { mergeStatic } from "../mergeStatic";
import type { GeometryCache } from "../geometryCache";
export function energy(cache?: GeometryCache) {
  const group = new T.Group(),
    anchors = {
      storage: new T.Vector3(-25, 3, 15),
      pv: new T.Vector3(23, 3, 18),
      grid: new T.Vector3(24, 3, -20),
      tower: new T.Vector3(0, 60, 0),
    };
  const curves: T.CatmullRomCurve3[] = [],
    dots: T.Mesh[][] = [],
    mats: T.MeshBasicMaterial[] = [];
  const steel = new T.MeshStandardMaterial({
    color: 0x64808a,
    metalness: 0.5,
    roughness: 0.4,
  });
  for (let i = 0; i < 4; i++) {
    const c = new T.Mesh(new T.BoxGeometry(2.5, 2.7, 6), steel);
    c.position.set(-29 + i * 3, 1.4, 15);
    c.castShadow = true;
    group.add(c);
  }
  const panel = new T.MeshStandardMaterial({
    color: 0x15385c,
    metalness: 0.7,
    roughness: 0.2,
  });
  for (let x = 0; x < 6; x++)
    for (let z = 0; z < 4; z++) {
      const p = new T.Mesh(new T.BoxGeometry(2.1, 0.12, 1.5), panel);
      p.position.set(17 + x * 2.3, 3, 14 + z * 1.7);
      p.rotation.x = -0.2;
      group.add(p);
      const leg = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, 3, 6), steel);
      leg.position.set(p.position.x, 1.5, p.position.z);
      group.add(leg);
    }
  for (let i = 0; i < 3; i++) {
    const c = new T.Mesh(new T.BoxGeometry(2, 4, 2), steel);
    c.position.set(21 + i * 3, 2, -20);
    group.add(c);
  }
  for (const [index, key] of (["storage", "pv", "grid"] as const).entries()) {
    const start = anchors[key];
    const curve = new T.CatmullRomCurve3([
      start,
      new T.Vector3(start.x * 0.6, 8, start.z * 0.6),
      new T.Vector3(0, 1, 0),
    ]);
    curves.push(curve);
    const line = new T.Mesh(
      new T.TubeGeometry(curve, 32, 0.09, 6, false),
      new T.MeshBasicMaterial({
        color: [0x4fd1d9, 0xf2b33d, 0x7589e8][index],
        transparent: true,
        opacity: 0.25,
      }),
    );
    group.add(line);
    const mat = new T.MeshBasicMaterial({
      color: [0x4fd1d9, 0xf2b33d, 0x7589e8][index],
    });
    mats.push(mat);
    const points = Array.from({ length: 7 }, () => {
      const m = new T.Mesh(new T.SphereGeometry(0.2, 6, 6), mat);
      group.add(m);
      return m;
    });
    dots.push(points);
  }
  const dotBatches = dots.map((points, i) => {
    const mesh = new T.InstancedMesh(
      points[0].geometry,
      mats[i],
      points.length,
    );
    mesh.frustumCulled = false;
    group.add(mesh);
    points.forEach((p, j) => {
      group.remove(p);
      if (j > 0) p.geometry.dispose();
    });
    return mesh;
  });
  mergeStatic(group, new Set(dotBatches), cache);
  const dummy = new T.Object3D();
  const syncDots = () =>
    dotBatches.forEach((batch, i) => {
      dots[i].forEach((point, j) => {
        dummy.position.copy(point.position);
        dummy.scale.copy(point.scale);
        if (!point.visible) dummy.scale.setScalar(0);
        dummy.updateMatrix();
        batch.setMatrixAt(j, dummy.matrix);
      });
      batch.instanceMatrix.needsUpdate = true;
    });
  return { group, anchors, curves, dots, mats, syncDots };
}
