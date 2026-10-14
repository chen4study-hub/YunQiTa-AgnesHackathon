import {expect,it,vi} from 'vitest';
import {qualityPixelRatio,watchDevicePixelRatio} from '../src/core/pixelRatio';
import {postfx} from '../src/core/postfx';
import * as T from 'three';
it('quality caps DPR at 2/1, preserves fractional and sub-1 ratios',()=>{
 for(const ratio of [0.8,1,1.25,2,3]){expect(qualityPixelRatio(ratio,'high')).toBe(Math.min(ratio,2));expect(qualityPixelRatio(ratio,'low')).toBe(Math.min(ratio,1));}
});
it('resolution watcher re-arms on every change and cleans up the current listener',()=>{
 let dpr=1;const rows:{text:string;add:ReturnType<typeof vi.fn>;remove:ReturnType<typeof vi.fn>;fn?:()=>void}[]=[];
 const media=(text:string)=>{const row={text,add:vi.fn(),remove:vi.fn(),fn:undefined as (()=>void)|undefined};row.add.mockImplementation((_e,fn)=>row.fn=fn);rows.push(row);return {addEventListener:row.add,removeEventListener:row.remove} as unknown as MediaQueryList;};
 const change=vi.fn();const stop=watchDevicePixelRatio(change,media,()=>dpr);expect(rows[0].text).toBe('(resolution: 1dppx)');dpr=1.25;rows[0].fn!();expect(rows[0].remove).toHaveBeenCalledOnce();expect(rows[1].text).toBe('(resolution: 1.25dppx)');dpr=2;rows[1].fn!();expect(rows[2].text).toBe('(resolution: 2dppx)');expect(change).toHaveBeenCalledTimes(2);stop();expect(rows[2].remove).toHaveBeenCalledOnce();rows[2].fn!();expect(change).toHaveBeenCalledTimes(2);
});
it('composer targets track pixel ratio and CSS resize without losing MSAA',()=>{
 const renderer={getPixelRatio:()=>1,getSize:(v:T.Vector2)=>v.set(320,180)} as unknown as T.WebGLRenderer;const fx=postfx(renderer,new T.Scene(),new T.PerspectiveCamera());
 for(const dpr of [1,1.25,2]){fx.composer.setPixelRatio(dpr);fx.composer.setSize(400,200);for(const rt of [fx.composer.renderTarget1,fx.composer.renderTarget2]){expect([rt.width,rt.height]).toEqual([400*dpr,200*dpr]);expect(rt.samples).toBe(4);}}
 fx.dispose();
});
