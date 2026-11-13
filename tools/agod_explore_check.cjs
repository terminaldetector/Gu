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
const Phase=require(path.join(A,'agod-phase.js')),Stage=require(path.join(A,'agod-stage.js')),Explore=require(path.join(A,'agod-explore.js'));
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
console.log('\n'+out.join('\n'));
console.log('\n%s — %d/%d',fail.length?'FAIL ('+fail.length+')':'PASS',out.length-fail.length,out.length);
if(fail.length)process.exitCode=1;
