'use strict';
/* AGOD frontier archive (agod-explore.js) on a synthetic stage whose truth is
   known (the walking game of agod_stage_check: the stage ends at x >= 240 with a
   3 s clear sequence; enemies on a schedule take a life). The archive, with only
   progress, resource, position and screen, must find a route to the stage end
   within a small budget; the route replayed on a fresh game with NO restore must
   trigger the stage detector, with no life lost. Search is not autonomous play:
   this checks the search and its replay, nothing more. */
const path=require('node:path');
const A=path.resolve(__dirname,'..','app/src/main/assets/lab');
const Phase=require(path.join(A,'agod-phase.js')),Stage=require(path.join(A,'agod-stage.js')),Explore=require(process.env.EXPLORE_MODULE||path.join(A,'agod-explore.js'));
const out=[],fail=[];const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
const W=64,H=48,R={X:2,LIVES:4,STAGE:5,LOCK:6,T:7,SCROLL:8};
function game(){
 let ram=new Uint8Array(64),pixels=new Uint32Array(W*H),frameNo=0;ram[R.X]=60;ram[R.LIVES]=5;
 const draw=()=>{const s=ram[R.STAGE],lock=ram[R.LOCK]>0&&ram[R.T]===1;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){let v=lock?10:(s===0?(((x+ram[R.SCROLL])>>3)+(y>>3))%2*120+40:((x>>2)*(y>>2)*37+s*91)%200+30);
   if(!lock&&Math.abs(x-(ram[R.X]>>2))<2&&y>36)v=250;pixels[y*W+x]=v|(v<<8)|(v<<16);}};
 function frame(mask){
  frameNo++;ram[10]=(ram[10]+1)&255;ram[11]=(ram[11]+(frameNo&3?0:1))&255;
  if(ram[R.LOCK]>0){ram[R.LOCK]--;if(ram[R.LOCK]===0&&ram[R.T]===1){ram[R.STAGE]++;ram[R.X]=20;}if(ram[R.LOCK]===0)ram[R.T]=0;draw();return;}
  if(mask&128&&ram[R.X]<250){ram[R.X]++;ram[R.SCROLL]=(ram[R.SCROLL]+1)&255;}if(mask&64&&ram[R.X]>2)ram[R.X]--;
  if(ram[R.STAGE]===0&&ram[R.X]>=240){ram[R.LOCK]=180;ram[R.T]=1;}
  /* an enemy that only hits a player standing in its zone at the wrong time */
  else if(ram[R.X]>=150&&ram[R.X]<170&&(frameNo%90)<30&&ram[R.LIVES]>0){ram[R.LIVES]--;ram[R.LOCK]=160;ram[R.T]=2;}
  draw();
 }
 draw();
 const names=['A','B','Select','Start','↑','↓','←','→'];
 return {actionSpec:{buttonCount:8,buttons:names.map((name,index)=>({index,name,mask:1<<index})),singleButtonMasks:names.map((_,i)=>1<<i)},
  observedRamBytes:64,ports:1,core:{pixels,videoWidth:W,videoHeight:H},
  run(mask,frames){for(let i=0;i<frames;i++)frame(mask);},readRam:()=>ram.slice(),
  snapshot:()=>({ram:ram.slice(),frameNo}),restore(s){ram=s.ram.slice();frameNo=s.frameNo;draw();},
  stateHash(){let h=0x811c9dc5;for(const b of ram)h=Math.imul(h^b,0x01000193)>>>0;return h.toString(16)+':'+frameNo;}};
}
const g=game(),probe=Phase.probe(g,{});
const start=g.snapshot();
const archive=Explore.createArchive(g,{actions:[0,64,128,1,65,129],readProgress:ram=>[ram[R.X]+256*ram[R.STAGE]],readResource:ram=>ram[R.LIVES],
 positionFields:[R.X],screen:()=>Stage.signature(g.core.pixels,W,H),seed:7});
let found=null;
for(let i=0;i<3000&&!found;i++){archive.explore();const b=archive.best();if(b&&b.progress>=240)found=b;}
const st=archive.stats();
console.log('archive: %j',st);
ok(!!found,'the archive reaches the stage end ('+st.framesRun+' frames, '+st.cells+' cells)');
/* replay the route from the start with NO restore, the stage detector watching */
const fresh=game();let restores=0;const real=fresh.restore;fresh.restore=x=>{restores++;return real(x);};
const monitor=Stage.createMonitor({probe,readResource:ram=>ram[R.LIVES]});
const route=found?found.trace:[];
for(const mask of route){const b=fresh.readRam();fresh.run(mask,8);const a=fresh.readRam();monitor.observe({mask,ramBefore:b,ramAfter:a,signature:Stage.signature(fresh.core.pixels,W,H)});}
for(let k=0;k<40;k++){const b=fresh.readRam();fresh.run(128,8);const a=fresh.readRam();monitor.observe({mask:128,ramBefore:b,ramAfter:a,signature:Stage.signature(fresh.core.pixels,W,H)});}
const tr=monitor.transitions();
ok(restores===0,'the replay restores nothing');
ok(fresh.readRam()[R.LIVES]===5,'the route loses no life ('+fresh.readRam()[R.LIVES]+' of 5)');
ok(tr.length===1,'the replayed route triggers exactly one stage transition ('+tr.length+')');
ok(fresh.readRam()[R.STAGE]===1,'ground truth: the replay is in stage 1');
/* a bounded archive (maxCells) stays within its bound and still finds the end */
const g2=game(),small=Explore.createArchive(g2,{actions:[0,64,128,1,65,129],readProgress:ram=>[ram[R.X]+256*ram[R.STAGE]],readResource:ram=>ram[R.LIVES],
 positionFields:[R.X],screen:()=>Stage.signature(g2.core.pixels,W,H),seed:7,maxCells:20});
let peak=0,reached=null;
for(let i=0;i<3000&&!reached;i++){small.explore();peak=Math.max(peak,small.stats().cells);const b=small.best();if(b&&b.progress>=240)reached=b;}
console.log('bounded archive: %j, peak %d',small.stats(),peak);
ok(peak<=21&&small.stats().evicted>0,'a bounded archive keeps at most its bound (peak '+peak+' of 20, '+small.stats().evicted+' evicted)');
ok(!!reached,'and still reaches the stage end ('+small.stats().framesRun+' frames)');
/* a SEGMENTED stage: the only progress field AGOD has is a per-segment counter that
   climbs to 255 and restarts at 0 when the next segment begins (x 128 -> 255, then
   from x 130 again from 0); the stage ends at x >= 240. Counted as gained along the
   trajectory, the next segment is ahead of the first; read raw, it looks 255 behind. */
const C=12;
function segmented(){const g=game();const run=g.run;
 const counter=()=>{const x=g.readRam()[R.X];return x<130?Math.min(255,x*2):Math.min(255,(x-130)*2);};
 g.run=(mask,frames)=>{for(let i=0;i<frames;i++){run(mask,1);}};g.counter=counter;return g;}
function searchSegmented(unwrap){const g=segmented();
 const a=Explore.createArchive(g,{actions:[0,64,128,1,65,129],readProgress:()=>[g.counter()],readResource:ram=>ram[R.LIVES],
  positionFields:[R.X],screen:()=>Stage.signature(g.core.pixels,W,H),seed:7,unwrap,horizons:[48],progressBucket:64,positionBucket:64});
 let reached=null,frames=0;for(let i=0;i<4000&&!reached;i++){a.explore();const b=a.best();
  /* ground truth from the game itself, never given to the archive */
  for(const c of a.cells().values())if(!reached){g.restore(c.snapshot);if(g.readRam()[R.STAGE]>=1||g.readRam()[R.X]>=240)reached=c;}
  frames=a.stats().framesRun;}
 return {reached:!!reached,frames,stats:a.stats()};}
const withUnwrap=searchSegmented(true),raw=searchSegmented(false);
console.log('segmented stage: unwrap %j | raw %j',{reached:withUnwrap.reached,frames:withUnwrap.frames,best:withUnwrap.stats.bestProgress},{reached:raw.reached,frames:raw.frames,best:raw.stats.bestProgress});
ok(withUnwrap.reached,'with progress counted as gained, the archive crosses a counter reset and reaches the stage end ('+withUnwrap.frames+' frames)');
ok(withUnwrap.stats.bestProgress>255,'and its frontier lies past the reset (best progress '+withUnwrap.stats.bestProgress+' > 255)');
ok(!raw.reached||raw.frames>withUnwrap.frames,'read raw, the same search does not reach it in the same budget, or takes longer ('+(raw.reached?raw.frames+' frames':'not reached')+')');
/* a stage that needs LIVES: three lives, two avoidable hit zones, then two gates that
   each take a life whatever the player does - only a route that took no avoidable hit
   ends with a life left at the end. 'lives' pushes one frontier per lives count. */
function gated(){const g=game();g.restore({ram:Object.assign(g.readRam(),{[R.LIVES]:3}),frameNo:0});const run1=g.run;
 g.run=(mask,frames)=>{for(let i=0;i<frames;i++){const r=g.readRam(),x0=r[R.X];run1(mask,1);const r2=g.readRam();
  if(r2[R.LOCK]===0&&((x0<200&&r2[R.X]>=200)||(x0<220&&r2[R.X]>=220))&&r2[R.LIVES]>0){r2[R.LIVES]--;g.restore({ram:r2,frameNo:i});}}};return g;}
function searchGated(select){const g=gated();
 const a=Explore.createArchive(g,{actions:[0,64,128,1,65,129],readProgress:ram=>[ram[R.X]+256*ram[R.STAGE]],readResource:ram=>ram[R.LIVES],
  positionFields:[R.X],screen:()=>Stage.signature(g.core.pixels,W,H),seed:3,allowLoss:true,floor:0,select});
 let reached=null;for(let i=0;i<6000&&!reached;i++){a.explore();const b=a.best();if(b&&b.progress>=240&&b.resource>0)reached=b;}
 return {reached:!!reached,frames:a.stats().framesRun,frontier:a.stats().frontierByResource};}
const byLives=searchGated('lives'),byFrontier=searchGated('frontier');
console.log('gated stage: lives %j | frontier %j',byLives,byFrontier);
ok(byLives.reached,"select 'lives' finds a route that keeps enough lives for two unavoidable hits ("+byLives.frames+' frames)');
const u1=Explore.unwrapStep(null,[250,3],true),u2=Explore.unwrapStep(u1,[0,2],true),u3=Explore.unwrapStep(u2,[5,1],true);
ok(u3.value[0]===255&&u3.value[1]===1,'unwrapStep: 250 -> 0 -> 5 is 255 gained; a small fall (3 -> 2 -> 1) stays a fall ('+u3.value+')');
console.log('\n'+out.join('\n'));
console.log('\n%s — %d/%d',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
if(fail.length)process.exitCode=1;
