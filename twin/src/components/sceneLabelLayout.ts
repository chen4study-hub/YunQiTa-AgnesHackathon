export interface LabelRect {x:number;y:number;width:number;height:number;}
export interface LabelInput {key:string; x:number;y:number;width:number;height:number;}
export function intersects(a:LabelRect,b:LabelRect,gap=0) {
  return a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;
}
/** Prefer projected anchors, but reserve the tower silhouette and already placed labels. */
export function layoutSceneLabels(labels:LabelInput[],width:number,height:number,tower:LabelRect) {
  const placed:LabelRect[]=[];const result=new Map<string,LabelRect>();const margin=6,gap=6;
  for(const label of labels){
    const w=label.width,h=label.height;
    const clampX=(x:number)=>Math.max(margin,Math.min(width-w-margin,x));
    const clampY=(y:number)=>Math.max(margin,Math.min(height-h-margin,y));
    const ideal={x:clampX(label.x-w/2),y:clampY(label.y-h-8)};
    const xs=[ideal.x,margin,width-w-margin,clampX(tower.x-w-gap),clampX(tower.x+tower.width+gap)];
    const ys=[ideal.y,margin,height-h-margin,clampY(tower.y-h-gap),clampY(tower.y+tower.height+gap)];
    for(const r of placed){xs.push(clampX(r.x-w-gap),clampX(r.x+r.width+gap));ys.push(clampY(r.y-h-gap),clampY(r.y+r.height+gap));}
    for(let y=margin;y<=height-h-margin;y+=h+gap)ys.push(y);
    let best:LabelRect|undefined,score=Infinity;
    for(const x of xs)for(const y of ys){const candidate={x,y,width:w,height:h};
      if(x<margin||y<margin||x+w>width-margin||y+h>height-margin||intersects(candidate,tower,gap)||placed.some(r=>intersects(candidate,r,gap)))continue;
      const distance=(x-ideal.x)**2+(y-ideal.y)**2;
      if(distance<score){best=candidate;score=distance;}
    }
    if(best){placed.push(best);result.set(label.key,best);}
  }
  return result;
}
