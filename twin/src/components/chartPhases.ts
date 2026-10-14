import type {ECharts,EChartsOption} from 'echarts';
import {chartPresentation} from './chartUpdate';
/** Give startup animation, axes and series separate paint opportunities; never rebuild the instance. */
export function phaseChartUpdate(instance:ECharts,option:EChartsOption,reduced:boolean,previous?:EChartsOption,onApplied?:()=>void){
 let raf=0,task:ReturnType<typeof setTimeout>|undefined,cancelled=false;
 const stages:EChartsOption[]=[];
 const starting=previous!==undefined&&previous.animation!==false&&option.animation===false&&Array.isArray(option.series);
 if(starting){
  stages.push({animation:false});
  stages.push({yAxis:option.yAxis});
  const old=Array.isArray(previous?.series)?previous.series:[];
  const series=(option.series as typeof old).map(s=>{
   const prior=old.find(p=>p.id===s.id);
   if(!prior)return s;
   return Object.fromEntries(Object.entries(s).filter(([key,value])=>key==='id'||JSON.stringify(value)!==JSON.stringify((prior as Record<string,unknown>)[key])));
  }) as EChartsOption['series'];
  const presentation=chartPresentation(option,reduced);
  stages.push({tooltip:presentation.tooltip,xAxis:presentation.xAxis,series});
 }else stages.push(chartPresentation(option,reduced));
 const schedule=()=>{raf=requestAnimationFrame(()=>{task=setTimeout(()=>{
  if(cancelled||instance.isDisposed())return;
  instance.setOption(stages.shift()!,{notMerge:false,lazyUpdate:false});
  if(stages.length)schedule();else onApplied?.();
 },0);});};schedule();
 return ()=>{cancelled=true;cancelAnimationFrame(raf);if(task!==undefined)clearTimeout(task);};
}
