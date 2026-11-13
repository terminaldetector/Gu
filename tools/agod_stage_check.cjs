'use strict';
/* AGOD stage-transition detector (agod-stage.js) on a synthetic game whose
   truth is known: walking right to the end of stage 0 starts a 3 s stage-clear
   sequence (no control, new scene after it); enemies on a fixed schedule take a
   life and 1.5 s of control (same scene). The detector, with only the causal
   phase probe, the verified resource and the screen, must report the stage end
   once, report every death as LOSS and never as a stage, and leave short
   stumbles alone. Nothing here is a commercial claim. */
const assert=require('node:assert/strict'),path=require('node:path');
const A=path.resolve(__dirname,'..','app/src/main/assets/lab');
const Phase=require(path.join(A,'agod-phase.js')),Stage=require(path.join(A,'agod-stage.js'));
const out=[],fail=[];const ok=(c,m)=>{out.push((c?'  ok    ':'  FAIL  ')+m);if(!c)fail.push(m);return c;};
const W=64,H=48,R={X:2,LIVES:4,STAGE:5,LOCK:6,T:7,SCROLL:8};
function game(){
 let ram=new Uint8Array(64),pixels=new Uint32Array(W*H);
 ram[R.X]=60;ram[R.LIVES]=5;ram[R.STAGE]=0;
 const draw=()=>{const s=ram[R.STAGE],lock=ram[R.LOCK]>0&&ram[R.T]===1;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){let v=lock?10:(s===0?(((x+ram[R.SCROLL])>>3)+(y>>3))%2*120+40:((x>>2)*(y>>2)*37+s*91)%200+30);
   if(!lock&&Math.abs(x-(ram[R.X]>>2))<2&&y>36)v=250;pixels[y*W+x]=v|(v<<8)|(v<<16);}};
 let frameNo=0;
 function frame(mask){
  frameNo++;ram[10]=(ram[10]+1)&255;ram[11]=(ram[11]+(frameNo&3?0:1))&255;   /* clocks, as real games have */
  if(ram[R.LOCK]>0){ram[R.LOCK]--;if(ram[R.LOCK]===0&&ram[R.T]===1){ram[R.STAGE]++;ram[R.X]=20;ram[R.T]=0;}if(ram[R.LOCK]===0)ram[R.T]=0;draw();return;}
  if(mask&128&&ram[R.X]<250){ram[R.X]++;ram[R.SCROLL]=(ram[R.SCROLL]+1)&255;}if(mask&64&&ram[R.X]>2)ram[R.X]--;
  if(ram[R.STAGE]===0&&ram[R.X]>=240){ram[R.LOCK]=180;ram[R.T]=1;}                 /* stage clear: 3 s, new scene */
  else if(frameNo%700===350&&ram[R.LIVES]>0){ram[R.LIVES]--;ram[R.LOCK]=160;ram[R.T]=2;} /* hit: a life and 2.7 s - as long as a stage end */
  else if(frameNo%500===123){ram[R.LOCK]=24;ram[R.T]=3;}                             /* stumble: 0.4 s */
  draw();
 }
 draw();
 const names=['A','B','Select','Start','\u2191','\u2193','\u2190','\u2192'];
 return {actionSpec:{buttonCount:8,buttons:names.map((name,index)=>({index,name,mask:1<<index})),singleButtonMasks:names.map((_,i)=>1<<i)},
  observedRamBytes:64,ports:1,core:{pixels,videoWidth:W,videoHeight:H},
  run(mask,frames){for(let i=0;i<frames;i++)frame(mask);},readRam:()=>ram.slice(),
  snapshot:()=>({ram:ram.slice(),frameNo}),restore(s){ram=s.ram.slice();frameNo=s.frameNo;draw();},
  stateHash(){let h=0x811c9dc5;for(const b of ram)h=Math.imul(h^b,0x01000193)>>>0;return h.toString(16);}};
}
const g=game();
const probe=Phase.probe(g,{});console.log('probe: %s axes %j',probe.phase,(probe.axes||[]).map(a=>({axis:a.axis,integrators:a.integrators,fields:a.fields})));
ok(probe.phase==='PLAYING'&&(probe.axes||[]).some(a=>a.axis==='horizontal'&&a.integrators>0),'the phase probe finds the walking game in play with a horizontal integrator');
const monitor=Stage.createMonitor({probe,readResource:ram=>ram[R.LIVES]});
ok(!!monitor,'the monitor is built from the probe alone');
/* one continuous episode: walk right, alternating left/right steps like a real policy */
for(let t=0;t<4800;t+=8){
 const mask=(t>>3)%5===0?64:128,before=g.readRam();g.run(mask,8);const after=g.readRam();
 monitor.observe({mask,ramBefore:before,ramAfter:after,signature:Stage.signature(g.core.pixels,W,H)});
}
const ev=monitor.events(),stages=monitor.transitions(),losses=ev.filter(e=>e.kind==='LOSS');
console.log('events: %j',ev.map(e=>({k:e.kind,f:e.frame,gap:e.gapFrames,n:e.novelty,r:e.reason})));
ok(stages.length===1,'exactly one stage transition is reported ('+stages.length+')');
ok(stages.length&&stages[0].gapFrames>=120&&stages[0].frame<700&&stages[0].lostResource===false,'it is the stage-clear gap (at frame '+(stages[0]&&stages[0].frame)+'), with no life lost');
ok(losses.length>=5,'every hit is a LOSS ('+losses.length+')');
ok(ev.filter(e=>e.kind==='GAP'&&/death/.test(e.reason||'')).length>=1,'a gap as long as a stage end but with a life lost is refused as a stage, with the reason');
ok(!ev.some(e=>e.kind==='STAGE_TRANSITION_CANDIDATE'&&e.lostResource),'no stage transition is ever a death');
ok(g.readRam()[R.STAGE]===1,'ground truth: the game is in stage 1');
console.log('\n'+out.join('\n'));
console.log('\n%s — %d/%d',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
if(fail.length)process.exitCode=1;
