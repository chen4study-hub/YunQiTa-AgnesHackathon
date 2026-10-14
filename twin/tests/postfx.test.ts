import {expect,it,vi} from 'vitest';
import * as T from 'three';
import {postfx} from '../src/core/postfx';
it('composer uses owned half-float targets with 4x MSAA and releases both',()=>{
 const renderer={getPixelRatio:()=>1,getSize:(v:T.Vector2)=>v.set(320,180)} as unknown as T.WebGLRenderer;
 const fx=postfx(renderer,new T.Scene(),new T.PerspectiveCamera());
 for(const target of [fx.composer.renderTarget1,fx.composer.renderTarget2]){expect(target.samples).toBe(4);expect(target.texture.type).toBe(T.HalfFloatType);expect([target.width,target.height]).toEqual([320,180]);}
 const first=vi.spyOn(fx.composer.renderTarget1,'dispose'),second=vi.spyOn(fx.composer.renderTarget2,'dispose');fx.dispose();expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledOnce();
});
