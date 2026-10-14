import {test,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {realReplayFixture} from './real-replay-fixture';
test.use({viewport:{width:1366,height:768},deviceScaleFactor:1,reducedMotion:'no-preference'});
test('4x CPU playback for 5 seconds remains >=40fps and <=50ms max frame',async({page,context},info)=>{
 const fixture=await realReplayFixture(page);console.log('REAL_FIXTURE',JSON.stringify({labelAdjusted:fixture.labelAdjusted}));
 await page.route('**/api/**',r=>r.abort());await page.goto('/?source=file&at=2026-10-12T11:25');await expect(page.locator('.twin-scene')).toHaveAttribute('data-render-active','true');await expect(page.locator('.overview-number .animated-number-text').first()).toHaveAttribute('data-target',fixture.data.hours[11].point_kw.toLocaleString('en-US',{minimumFractionDigits:1,maximumFractionDigits:1}));await page.waitForTimeout(2000);
 const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 if(process.env.PROFILE_PLAYBACK){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
 // Arm measurement BEFORE the click, including its first frame and startup long tasks.
 const result=await page.evaluate(()=>new Promise<{fps:number;maxMs:number;frames:number;longFrames:{delta:number;time:number;cost:unknown}[];sun:{time:number;x:number}[];longTasks:{start:number;duration:number}[]}>(resolve=>{
  const longFrames:{delta:number;time:number;cost:unknown}[]=[],deltas:number[]=[],sun:{time:number;x:number}[]=[];let start=0,last=0;
  const longTasks:{start:number;duration:number}[]=[];const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())longTasks.push({start:entry.startTime-start,duration:entry.duration});});observer.observe({type:'longtask'});
  const tick=(now:number)=>{if(!start){start=now;const play=Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.trim()==='▶ 播放');if(!play)throw new Error('play button missing');play.click();}if(last)deltas.push(now-last);last=now;const state=JSON.parse(document.querySelector('.twin-scene')!.getAttribute('data-scene')!);if(deltas.at(-1)!>30)longFrames.push({delta:deltas.at(-1)!,time:state.visualHour,cost:state.frameCost});sun.push({time:state.visualHour,x:state.sunDirection[0]});if(now-start<5000)requestAnimationFrame(tick);else {observer.disconnect();resolve({fps:deltas.length*1000/(now-start),maxMs:Math.max(...deltas),frames:deltas.length,longFrames,sun,longTasks});}};requestAnimationFrame(tick);
 }));
 if(process.env.PROFILE_PLAYBACK){const profile=await cdp.send('Profiler.stop');writeFileSync(join(process.env.TEMP!,'agh-playback-profile.json'),JSON.stringify(profile));await info.attach('cpu-profile.json',{body:JSON.stringify(profile),contentType:'application/json'});}
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});await info.attach('performance.json',{body:JSON.stringify(result),contentType:'application/json'});console.log('PLAYBACK_PERF',JSON.stringify({fps:result.fps,maxMs:result.maxMs,frames:result.frames,longFrames:result.longFrames,longTasks:result.longTasks}));
 expect.soft(result.fps).toBeGreaterThanOrEqual(40);expect.soft(result.maxMs).toBeLessThanOrEqual(50);
 const sameHour=result.sun.filter(p=>p.time>=12&&p.time<13);expect(sameHour.length).toBeGreaterThan(15);for(let i=1;i<sameHour.length;i++)expect(sameHour[i].x).toBeLessThanOrEqual(sameHour[i-1].x+1e-6);expect(new Set(sameHour.map(p=>p.x)).size).toBeGreaterThan(sameHour.length*0.8);
});
