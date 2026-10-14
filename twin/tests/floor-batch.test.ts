import {it,expect,vi} from 'vitest';
import * as T from 'three';
import {tower} from '../src/core/building/tower';
it('batching preserves all floor triangles, source mullions and per-floor color/expansion controls',()=>{
 vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>({fillStyle:'',fillRect:()=>{}})})});
 try{const building=tower({floors:40,sqm:80000,twistDeg:78,baseWidth:6.5,topWidth:4.2,taperExponent:.8,gardenFloors:[14,27]});
 const vertices=(mesh:T.Mesh)=>mesh.geometry.index?.count??mesh.geometry.getAttribute('position').count;
 const sources=building.floors.flatMap(f=>f.children.filter(c=>c instanceof T.Mesh)) as T.Mesh[];
 expect(building.batch.meshes).toHaveLength(4);expect(building.batch.meshes.reduce((sum,m)=>sum+vertices(m),0)).toBe(sources.reduce((sum,m)=>sum+vertices(m),0));expect(sources.every(m=>!m.visible)).toBe(true);
 const glass=building.batch.meshes.find(m=>m.name==='batched-floor-glass')!;expect(glass.geometry.hasAttribute('color')).toBe(true);expect(glass.geometry.hasAttribute('floorIndex')).toBe(true);
 const shader={uniforms:{},vertexShader:'#include <common>\n#include <begin_vertex>',fragmentShader:'#include <common>\nvec4 diffuseColor = vec4( diffuse, opacity );\nvec3 totalEmissiveRadiance = emissive;'} as any;
 building.batch.glassMaterial.onBeforeCompile(shader,null as any);building.glass[3].color.set('#ff0000');building.glass[3].emissiveIntensity=.4;building.batch.update(2.4,null);expect(shader.uniforms.floorSpacing.value).toBe(2.4);expect(shader.uniforms.floorColors.value[3].getHex()).toBe(0xff0000);expect(shader.uniforms.floorEmission.value[3]).toBe(.4);expect(shader.vertexShader).toContain('floorIndex * (floorSpacing - 1.3)');
 building.batch.update(1.3,3);expect(shader.uniforms.selectedLayer.value).toBe(3);expect(sources.filter(m=>m.visible)).toHaveLength(1);expect(sources.find(m=>m.visible)!.userData.floor).toBe(3);
 const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>();building.root.traverse(o=>{const m=o as T.Mesh;if(m.geometry)geometries.add(m.geometry);if(m.material)(Array.isArray(m.material)?m.material:[m.material]).forEach(x=>materials.add(x));if(m.customDepthMaterial)materials.add(m.customDepthMaterial);});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());building.glass[0].emissiveMap?.dispose();
 }finally{vi.unstubAllGlobals();}
});
