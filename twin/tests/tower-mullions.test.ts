import {expect,it,vi} from 'vitest';
import * as T from 'three';
import {tower} from '../src/core/building/tower';
it('48 thicker frames sit only on straight inset glass faces, match glass height, and skip garden floors',()=>{
 vi.stubGlobal('document',{createElement:()=>({width:0,height:0,getContext:()=>({fillStyle:'',fillRect:()=>{}})})});
 try{
 const spec={floors:40,sqm:80000,twistDeg:78,baseWidth:6.5,topWidth:4.2,taperExponent:0.8,gardenFloors:[14,27]};const building=tower(spec);
 building.floors.forEach((floor,index)=>{
  const mesh=floor.getObjectByName('glass-mullions') as T.Mesh<T.BufferGeometry>|undefined;
  if(spec.gardenFloors.includes(index+1)){expect(mesh).toBeUndefined();return;}
  expect(mesh).toBeDefined();const vertices=mesh!.geometry.getAttribute('position');expect(vertices.count).toBe(48*24);
  const w=spec.baseWidth+(spec.topWidth-spec.baseWidth)*(index/39)**spec.taperExponent,face=w-0.12,straight=face-0.9;
  for(let j=0;j<48;j++){
   const points=Array.from({length:24},(_,i)=>new T.Vector3().fromBufferAttribute(vertices,j*24+i));const box=new T.Box3().setFromPoints(points),center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3());
   expect(size.x).toBeCloseTo(0.07,5);expect(size.z).toBeCloseTo(0.07,5);expect(size.y).toBeCloseTo(1.05,5);expect(box.min.y).toBeCloseTo(0.16,5);expect(box.max.y).toBeCloseTo(1.21,5);
   const side=Math.floor(j/12);if(side===0||side===2){expect(Math.abs(center.z)).toBeCloseTo(face,5);expect(Math.max(Math.abs(box.min.x),Math.abs(box.max.x))).toBeLessThan(straight);}else{expect(Math.abs(center.x)).toBeCloseTo(face,5);expect(Math.max(Math.abs(box.min.z),Math.abs(box.max.z))).toBeLessThan(straight);}
  }
 });
 // Release test-created GPU descriptors/CPU geometry including the canvas texture.
 const geos=new Set<T.BufferGeometry>(),mats=new Set<T.Material>();building.root.traverse(o=>{const m=o as T.Mesh;if(m.geometry)geos.add(m.geometry);if(m.material)(Array.isArray(m.material)?m.material:[m.material]).forEach(x=>mats.add(x));});geos.forEach(g=>g.dispose());mats.forEach(m=>m.dispose());building.glass[0].emissiveMap?.dispose();
 }finally{vi.unstubAllGlobals();}
});
