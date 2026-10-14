import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {phaseChartUpdate} from '../src/components/chartPhases';
import {stubRaf} from './raf-test-helper';
import type {XAXisComponentOption} from 'echarts';
beforeEach(()=>{vi.useFakeTimers();stubRaf();});afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('startup separates animation, axis and changed series; completion only follows the final stage',()=>{
 const setOption=vi.fn(),applied=vi.fn(),instance={setOption,isDisposed:()=>false} as any;
 const previous={animation:true,series:[{id:'actual',type:'line' as const,data:[1,2]}]};
 const option={animation:false,yAxis:{min:0,max:100},xAxis:{data:['11','12']},series:[{id:'actual',type:'line' as const,data:[1,2]}]};
 phaseChartUpdate(instance,option,true,previous,applied);
 vi.advanceTimersByTime(17);expect(setOption).toHaveBeenNthCalledWith(1,{animation:false},{notMerge:false,lazyUpdate:false});expect(applied).not.toHaveBeenCalled();
 vi.advanceTimersByTime(17);expect(setOption).toHaveBeenNthCalledWith(2,{yAxis:option.yAxis},{notMerge:false,lazyUpdate:false});expect(applied).not.toHaveBeenCalled();
 vi.advanceTimersByTime(17);expect(setOption).toHaveBeenNthCalledWith(3,expect.objectContaining({xAxis:option.xAxis,series:[{id:'actual'}]}),{notMerge:false,lazyUpdate:false});expect(applied).toHaveBeenCalledTimes(1);
});
it('phased startup applies the same tooltip title and number fallback as a normal update',()=>{
 const setOption=vi.fn(),instance={setOption,isDisposed:()=>false} as any;
 const format=(hour:number)=>`${hour}:00`;
 phaseChartUpdate(instance,{animation:false,xAxis:{type:'value',axisLabel:{formatter:format}},series:[]},true,{animation:true,series:[]});
 vi.advanceTimersByTime(55);
 const presentation=setOption.mock.calls.at(-1)![0];
 expect(presentation.tooltip.valueFormatter(1381.5224997184777,0)).toBe('1,381.5');
 const axis=presentation.xAxis as XAXisComponentOption;
 const formatter=axis.axisPointer!.label!.formatter as (p:{value:number})=>string;
 expect(formatter({value:18})).toBe('18:00');
});
it('cancelling a partially applied startup prevents remaining stages and completion',()=>{
 const setOption=vi.fn(),applied=vi.fn(),instance={setOption,isDisposed:()=>false} as any;
 const cancel=phaseChartUpdate(instance,{animation:false,series:[]},true,{animation:true},applied);
 vi.advanceTimersByTime(17);expect(setOption).toHaveBeenCalledTimes(1);cancel();vi.advanceTimersByTime(100);expect(setOption).toHaveBeenCalledTimes(1);expect(applied).not.toHaveBeenCalled();
});
it('chart work runs after frame paint, and cancelling before or after rAF prevents stale model/render work',()=>{
 const setOption=vi.fn(),instance={setOption,isDisposed:()=>false} as any;
 phaseChartUpdate(instance,{animation:false,series:[{id:'a',type:'line',data:[1,2]}]},true);expect(setOption).not.toHaveBeenCalled();vi.advanceTimersByTime(16);expect(setOption).not.toHaveBeenCalled();vi.advanceTimersByTime(1);expect(setOption).toHaveBeenCalledWith(expect.objectContaining({animation:false}),{notMerge:false,lazyUpdate:false});
 setOption.mockClear();phaseChartUpdate(instance,{},false)();vi.advanceTimersByTime(32);expect(setOption).not.toHaveBeenCalled();
 const cancel=phaseChartUpdate(instance,{},false);vi.advanceTimersByTime(16);cancel();vi.advanceTimersByTime(32);expect(setOption).not.toHaveBeenCalled();
});
