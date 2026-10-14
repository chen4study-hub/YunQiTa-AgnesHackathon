import type { ReplayData } from '../data/types';
export interface FloorColorScale { p10: number; p50: number; p90: number; }
export const FLOOR_COLORS = ['#2FBF8F', '#E5BE6A', '#F29252'] as const;
export const EQUIPMENT_COLOR = '#8597A3';
const anchors=FLOOR_COLORS.map(hex=>hex.slice(1).match(/../g)!.map(c=>parseInt(c,16)));
const hexByte=Array.from({length:256},(_,i)=>i.toString(16).padStart(2,'0').toUpperCase());
export function quantile(values: readonly number[], p: number) {
  const sorted = values.filter(Number.isFinite).slice().sort((a,b)=>a-b);
  if (!sorted.length) return 0;
  const position = Math.max(0,Math.min(1,p))*(sorted.length-1), index = Math.floor(position);
  return sorted[index]+(sorted[Math.min(index+1,sorted.length-1)]-sorted[index])*(position-index);
}
export function floorScale(values: readonly number[]): FloorColorScale {
  return {p10:quantile(values,.1),p50:quantile(values,.5),p90:quantile(values,.9)};
}
const cache = new WeakMap<ReplayData, FloorColorScale>();
/** Fixed daily reference: office cells from 08:00 through 20:00 inclusive (13 origins).
 * This window never follows the cursor. Exclude equipment/lobby/garden and all night samples.
 * Both overview 3D and floor-page charts use this one function. */
export function dailyFloorScale(data: ReplayData) {
  let scale = cache.get(data);
  if(!scale) { scale = Object.freeze(floorScale(data.hours.slice(8,21).flatMap(hour=>hour.floors_kw.filter((_,index)=>data.meta.floor_uses[index]==='office')))); cache.set(data,scale); }
  return scale;
}
// Optional usage keeps existing two-argument callers compatible; pages can opt into equipment grey.
export function floorColor(load: number, scale: FloorColorScale, floorUse?: string): string {
  if(floorUse==='equipment'||!Number.isFinite(load)) return EQUIPMENT_COLOR;
  if(scale.p10===scale.p90) return FLOOR_COLORS[1];
  const lower = load < scale.p50;
  const a = lower ? scale.p10 : scale.p50, b = lower ? scale.p50 : scale.p90;
  const t = b===a ? (load>=b?1:0) : Math.max(0,Math.min(1,(load-a)/(b-a)));
  const from=anchors[lower?0:1],to=anchors[lower?1:2];
  return '#'+hexByte[Math.round(from[0]+(to[0]-from[0])*t)]+hexByte[Math.round(from[1]+(to[1]-from[1])*t)]+hexByte[Math.round(from[2]+(to[2]-from[2])*t)];
}
