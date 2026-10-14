import {vi} from 'vitest';
/** Node test environment has no native rAF; fake timers drive the browser-shaped scheduler. */
export function stubRaf() {
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>setTimeout(()=>fn(performance.now()),16));
 vi.stubGlobal('cancelAnimationFrame',(id:ReturnType<typeof setTimeout>)=>clearTimeout(id));
}
