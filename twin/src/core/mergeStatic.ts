import * as T from "three";
import type { GeometryCache } from "./geometryCache";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
/** Merge same-material static children, preserving every triangle, normal, UV and shadow flag. */
export function mergeStatic(
  group: T.Group,
  exclude: ReadonlySet<T.Object3D> = new Set(),
  cache?: GeometryCache,
) {
  const entries = new Map<
    string,
    {
      material: T.Material;
      shadow: boolean;
      receive: boolean;
      meshes: T.Mesh[];
    }
  >();
  group.children.forEach((o) => {
    if (!(o instanceof T.Mesh) || exclude.has(o) || Array.isArray(o.material))
      return;
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        material: o.material,
        shadow: o.castShadow,
        receive: o.receiveShadow,
        meshes: [],
      };
      entries.set(key, entry);
    }
    entry.meshes.push(o);
  });
  let index = 0;
  entries.forEach((entry) => {
    if (entry.meshes.length < 2) return;
    const generate = () => {
      const pieces = entry.meshes.map((mesh) => {
        mesh.updateMatrix();
        let geometry = mesh.geometry.clone();
        if (geometry.index) {
          const next = geometry.toNonIndexed();
          geometry.dispose();
          geometry = next;
        }
        geometry.clearGroups();
        geometry.applyMatrix4(mesh.matrix);
        return geometry;
      });
      const geometry = mergeGeometries(pieces)!;
      pieces.forEach((g) => g.dispose());
      return geometry;
    };
    const merged = new T.Mesh(
      cache?.get(`energy-static:${index++}`, generate) ?? generate(),
      entry.material,
    );
    merged.castShadow = entry.shadow;
    merged.receiveShadow = entry.receive;
    group.add(merged);
    entry.meshes.forEach((mesh) => {
      group.remove(mesh);
      mesh.geometry.dispose();
    });
  });
}
