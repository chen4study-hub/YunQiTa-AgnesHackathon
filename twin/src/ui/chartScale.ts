/** Outward nice integer bounds, never isolated labels at raw data extrema. */
export function niceIntegerScale(low:number,high:number){
 const padding=Math.max(10,(high-low)*0.08);
 const span=high-low+2*padding,rough=span/4;
 const magnitude=10**Math.floor(Math.log10(rough));
 const interval=Math.max(1,([1,2,5,10].find(n=>n*magnitude>=rough)??10)*magnitude);
 return {min:Math.floor((low-padding)/interval)*interval,max:Math.ceil((high+padding)/interval)*interval,interval};
}
