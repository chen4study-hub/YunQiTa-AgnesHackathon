import type {ReplayData} from './types';
import {predictionWindow} from './forecast';
import {niceIntegerScale} from '../ui/chartScale';
export interface OverviewSlot {
 t:number;actual:number|null;point:number|null;lower:number|null;upper:number|null;realized_abstain:boolean;
}
export interface OverviewPlayback {startHour:number;elapsedHours:number;}
const scaleCache=new WeakMap<ReplayData,Map<number,ReturnType<typeof niceIntegerScale>>>();
const gateCache=new WeakMap<ReplayData,Map<number,readonly boolean[]>>();
/** One immutable gate snapshot per fixed origin; future window refreshes cannot move red slots. */
export function playbackWindowGates(data:ReplayData,startHour:number){
 const origin=Math.floor(startHour);let cache=gateCache.get(data);if(!cache){cache=new Map();gateCache.set(data,cache);}
 const existing=cache.get(origin);if(existing)return existing;
 const gates=Object.freeze([false,false,...predictionWindow(data,origin).forecast_24h.map(p=>p.realized_abstain)]);
 cache.set(origin,gates);return gates;
}
/** Freeze the entire fixed window's facts and every current-origin prediction that may be shown. */
export function playbackWindowScale(data:ReplayData,startHour:number){
 const origin=Math.floor(startHour);let cache=scaleCache.get(data);if(!cache){cache=new Map();scaleCache.set(data,cache);}const found=cache.get(origin);if(found)return found;
 const values=predictionWindow(data,origin).recent_actual.map(p=>p.actual_kw).filter((v):v is number=>v!==null);
 for(let t=origin;t<=origin+24;t++)values.push(data.hours[((t%24)+24)%24].actual_kw);
 for(let issued=origin;issued<origin+24;issued++){
  for(const point of predictionWindow(data,((issued%24)+24)%24).forecast_24h){const target=issued+point.t-((issued%24)+24)%24;if(target<=origin+24)values.push(point.point_kw,point.lower_kw,point.upper_kw);}
 }
 const scale=Object.freeze(niceIntegerScale(Math.min(...values),Math.max(...values)));cache.set(origin,scale);return scale;
}
/** Fixed hourly sample positions; the continuous head is independent of hourly series refresh. */
export function overviewWindow(data:ReplayData,time:number,playback?:OverviewPlayback){
 const start=playback?.startHour ?? Math.floor(time);
 const origin=Math.floor(start),head=playback ? start+Math.max(0,Math.min(24,playback.elapsedHours)) : origin;
 const initial=predictionWindow(data,origin);
 const fixedGates=playback?playbackWindowGates(data,start):null;
 const currentOrigin=Math.floor(head);
 const current=predictionWindow(data,((currentOrigin%24)+24)%24);
 const slots:OverviewSlot[]=Array.from({length:26},(_,index)=>{
  const t=origin-1+index,measured=t<=Math.floor(head);
  const initialPoint=initial.forecast_24h[index-2];
  const target=data.hours[((t%24)+24)%24];
  const actual=index<2 ? initial.recent_actual[index].actual_kw : playback && measured ? target.actual_kw : null;
  const prediction=playback ? current.forecast_24h.find(p=>p.t-current.generated_at===t-currentOrigin) : initialPoint;
  // Keep a measured endpoint on the forecast line for a connected seam, never future actuals.
  const seam=t===Math.floor(head) && t<origin+24;
  return {t,actual:measured?actual:null,point:seam?actual:!measured?prediction?.point_kw??null:null,lower:seam?actual:!measured?prediction?.lower_kw??null:null,upper:seam?actual:!measured?prediction?.upper_kw??null:null,realized_abstain:fixedGates?fixedGates[index]:index>=2 ? initialPoint.realized_abstain : false};
 });
 return {slots,head,origin,playback:!!playback};
}
