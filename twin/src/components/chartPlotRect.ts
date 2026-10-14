import type {ECharts} from 'echarts';
/** Read the rendered grid, not proposed numeric extrema before lazyUpdate has applied them. */
export function chartPlotRect(instance:ECharts){
 const model=(instance as unknown as {getModel:()=>{getComponent:(name:string,index:number)=>{coordinateSystem:{getRect:()=>{x:number;y:number;width:number;height:number}}}}}).getModel();
 const rect=model.getComponent('grid',0).coordinateSystem.getRect();
 const host=instance.getDom(),parent=host.parentElement!;
 const hostRect=host.getBoundingClientRect(),parentRect=parent.getBoundingClientRect();
 return {left:rect.x+hostRect.left-parentRect.left,right:rect.x+rect.width+hostRect.left-parentRect.left,top:rect.y+hostRect.top-parentRect.top,bottom:rect.y+rect.height+hostRect.top-parentRect.top};
}
