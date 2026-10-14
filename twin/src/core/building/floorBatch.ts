import * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { GeometryCache } from "../geometryCache";
/** Preserve exact source geometry/UV/normals; move expanded floors in the vertex shader. */
export function floorBatch(
  root: T.Group,
  floors: T.Group[],
  glass: T.MeshStandardMaterial[],
  metal: T.MeshStandardMaterial,
  cache?: GeometryCache,
) {
  const spacing = { value: 1.3 },
    colors = { value: glass.map((m) => m.color.clone()) },
    emission = { value: glass.map(() => 0) },
    opacity = { value: glass.map(() => 1) },
    selected = { value: -1 };
  const batches: T.Mesh[] = [];
  const groups = new Map<
    string,
    {
      material: T.Material;
      shadow: boolean;
      sources: { floor: T.Group; child: T.Mesh; i: number }[];
      glass: boolean;
    }
  >();
  floors.forEach((floor, i) => {
    floor.updateMatrix();
    floor.children.forEach((child) => {
      if (!(child instanceof T.Mesh)) return;
      child.updateMatrix();
      const isGlass = child.material === glass[i];
      const material = isGlass ? glass[0] : (child.material as T.Material);
      const key = `${material.uuid}|${child.castShadow}|${isGlass}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = {
          material,
          shadow: child.castShadow,
          sources: [],
          glass: isGlass,
        };
        groups.set(key, entry);
      }
      entry.sources.push({ floor, child, i });
      child.visible = false;
    });
  });
  const glassMaterial = glass[0].clone();
  glassMaterial.color.set(0xffffff);
  glassMaterial.emissive.set(0xffffff);
  glassMaterial.emissiveIntensity = 1;
  glassMaterial.vertexColors = true;
  const patchVertex = (source: string, isGlass = false) =>
    source
      .replace(
        "#include <common>",
        `#include <common>\nattribute float floorIndex;uniform float floorSpacing;${isGlass ? "uniform vec3 floorColors[40];uniform float floorEmission[40];uniform float floorOpacity[40];varying vec3 layerColor;varying float layerEmission;varying float layerOpacity;varying float layerIndex;" : ""}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\ntransformed.y += floorIndex * (floorSpacing - 1.3);${isGlass ? "int layer=int(floorIndex);layerColor=floorColors[layer];layerEmission=floorEmission[layer];layerOpacity=floorOpacity[layer];layerIndex=floorIndex;vColor*=layerColor;" : ""}`,
      );
  const patch = (material: T.Material, isGlass = false) => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.floorSpacing = spacing;
      shader.vertexShader = patchVertex(shader.vertexShader, isGlass);
      if (isGlass) {
        Object.assign(shader.uniforms, {
          floorColors: colors,
          floorEmission: emission,
          floorOpacity: opacity,
          selectedLayer: selected,
        });
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            "#include <common>\nvarying vec3 layerColor;varying float layerEmission;varying float layerOpacity;varying float layerIndex;uniform float selectedLayer;",
          )
          .replace(
            "vec4 diffuseColor = vec4( diffuse, opacity );",
            "if(abs(layerIndex-selectedLayer)<0.1) discard;\nvec4 diffuseColor = vec4( diffuse, layerOpacity );",
          )
          .replace(
            "vec3 totalEmissiveRadiance = emissive;",
            "vec3 totalEmissiveRadiance = layerColor * layerEmission;",
          );
      }
    };
    material.customProgramCacheKey = () => `floor-batch-${isGlass}`;
  };
  patch(glassMaterial, true);
  let batchIndex = 0;
  groups.forEach((entry) => {
    const generate = () => {
      const pieces = entry.sources.map(({ floor, child, i }) => {
        let g = child.geometry.clone();
        if (g.index) {
          const next = g.toNonIndexed();
          g.dispose();
          g = next;
        }
        g.applyMatrix4(
          new T.Matrix4().multiplyMatrices(floor.matrix, child.matrix),
        );
        g.clearGroups();
        g.setAttribute(
          "floorIndex",
          new T.Float32BufferAttribute(
            new Float32Array(g.getAttribute("position").count).fill(i),
            1,
          ),
        );
        if (entry.glass)
          g.setAttribute(
            "color",
            new T.Float32BufferAttribute(
              new Float32Array(g.getAttribute("position").count * 3).fill(1),
              3,
            ),
          );
        return g;
      });
      const merged = mergeGeometries(pieces)!;
      pieces.forEach((g) => g.dispose());
      return merged;
    };
    const geometry =
      cache?.get(`floor-batch:${batchIndex++}`, generate) ?? generate();
    const material = entry.glass ? glassMaterial : entry.material.clone();
    if (!entry.glass) patch(material);
    const mesh = new T.Mesh(geometry, material);
    mesh.userData.floorMetal = entry.material === metal;
    mesh.name = entry.glass
      ? "batched-floor-glass"
      : entry.shadow
        ? "batched-floor-slabs"
        : "batched-floor-details";
    mesh.castShadow = entry.shadow;
    mesh.frustumCulled = false;
    if (entry.shadow) {
      const depth = new T.MeshDepthMaterial({
        depthPacking: T.RGBADepthPacking,
      });
      patch(depth);
      mesh.customDepthMaterial = depth;
    }
    root.add(mesh);
    batches.push(mesh);
  });
  const sourceGlass = floors.map(
    (floor, i) =>
      floor.children.find(
        (c) => c instanceof T.Mesh && c.material === glass[i],
      ) as T.Mesh,
  );
  return {
    meshes: batches,
    glassMaterial,
    update: (space: number, selectedFloor: number | null) => {
      spacing.value = space;
      // Selected opaque glass retains its original independent depth-write and geometry.
      const separate =
        selectedFloor !== null && !glass[selectedFloor].transparent;
      selected.value = separate ? selectedFloor! : -1;
      sourceGlass.forEach(
        (mesh, i) => (mesh.visible = separate && i === selectedFloor),
      );
      const transparent = glass.some((m) => m.transparent);
      if (glassMaterial.transparent !== transparent) {
        glassMaterial.transparent = transparent;
        glassMaterial.needsUpdate = true;
      }
      glassMaterial.depthWrite = !transparent;
      glass.forEach((m, i) => {
        colors.value[i].copy(m.color);
        emission.value[i] = m.emissiveIntensity;
        opacity.value[i] = m.opacity;
      });
      batches.forEach((mesh) => {
        if (
          mesh.material instanceof T.MeshStandardMaterial &&
          mesh.userData.floorMetal
        ) {
          const m = mesh.material;
          if (m.transparent !== metal.transparent) {
            m.transparent = metal.transparent;
            m.needsUpdate = true;
          }
          m.opacity = metal.opacity;
          m.depthWrite = metal.depthWrite;
        }
      });
    },
  };
}
