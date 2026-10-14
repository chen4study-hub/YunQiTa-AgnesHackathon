import type {DashboardState,DashboardStore} from './store';
/** Hourly presentation subscribers publish on different frames; continuous playback is untouched. */
export function phasedSubscription(store:DashboardStore,frames:number){
 let snapshot=store.getSnapshot(),raf=0,stop:(()=>void)|null=null;
 const listeners=new Set<()=>void>();
 const publish=()=>{raf=0;snapshot=store.getSnapshot();listeners.forEach(fn=>fn());};
 const changed=()=>{
  const next=store.getSnapshot();cancelAnimationFrame(raf);raf=0;
  const hourly=snapshot.playing&&next.playing&&(snapshot.hour!==next.hour||new Date(snapshot.nowMs).toDateString()!==new Date(next.nowMs).toDateString());
  const starting=!snapshot.playing&&next.playing;
  if(!hourly&&!starting){publish();return;}
  let remaining=frames;const tick=()=>{if(--remaining<=0)publish();else raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);
 };
 return {getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{
  listeners.add(listener);if(!stop){snapshot=store.getSnapshot();stop=store.subscribe(changed);}
  return ()=>{listeners.delete(listener);if(!listeners.size){stop?.();stop=null;cancelAnimationFrame(raf);raf=0;}};
 }};
}
