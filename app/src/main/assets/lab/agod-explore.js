/* AGOD frontier archive (directive 2026-11-13, section 6) - the research copy of
   the emulator only, never a person's game and never an evaluation run.

   WHAT IT IS FOR. Finding a route through a stage that no policy can yet play:
   return to the furthest place already reached and explore from there (the
   Go-Explore pattern: Ecoffet et al., Nature 2021). It is AGOD's exploration, not
   a learner - it pays nothing to anyone. What it produces is a ROUTE: the full
   action trace from the legal start, which the caller replays on a freshly loaded
   cartridge with no restore before anything is claimed.

   CELLS. A cell is what AGOD can see without game rules: the discovered progress
   fields (bucketed), the controlled position (bucketed, from the causal probe),
   the verified resource, and a coarse screen (8 x 6, 3 levels). Per cell the
   archive keeps ONE entry: the savestate and the full action trace that reached
   it - the one with the most resource left, then the shortest.

   SELECTION. Cells are scored by progress (the frontier) and by how rarely they
   were chosen; a cell whose explorations keep failing loses priority.

   EXPLORATION. From the chosen cell: sticky actions from the discovery action set
   (held 8-32 frames), for a horizon of 96, 192 or 384 frames, stopping at a loss
   of the resource. Every stride's state is offered to the archive. */
'use strict';
(function(root){
const EXPLORE_REVISION='agod-explore-r1';
const DEFAULTS=Object.freeze({stride:8,horizons:Object.freeze([96,192,384]),holdMin:1,holdMax:4,
 progressBucket:4,positionBucket:16,screenLevels:3,seed:1});

function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}

/* options: {actions:[masks], readProgress(ram)->[numbers], readResource(ram)->number,
   positionFields:[addresses], screen()->Float32Array|null, ...DEFAULTS} */
function createArchive(driver,options){
 const o={...DEFAULTS,...(options||{})};
 const random=rng(o.seed);
 const cells=new Map();let explorations=0,framesRun=0,bestProgress=-Infinity,bestCell=null;
 const total=v=>v.reduce((s,x)=>s+(Number.isFinite(x)?x:0),0);
 function key(ram){
  const prog=(o.readProgress(ram)||[]).map(v=>Number.isFinite(v)?Math.floor(v/o.progressBucket):-1);
  const pos=(o.positionFields||[]).map(a=>Math.floor(ram[a]/o.positionBucket));
  const res=o.readResource(ram);
  const scr=o.screen?o.screen():null;
  let s='';if(scr)for(let i=0;i<scr.length;i++)s+=Math.min(o.screenLevels-1,Math.floor(scr[i]*o.screenLevels));
  return prog.join(',')+'|'+pos.join(',')+'|'+res+'|'+s;
 }
 function offer(trace,ram){
  const k=key(ram),prog=total(o.readProgress(ram)||[]),res=o.readResource(ram);
  const prev=cells.get(k);
  if(prev&&(prev.resource>res||(prev.resource===res&&prev.trace.length<=trace.length)))return false;
  cells.set(k,{key:k,trace:trace.slice(),snapshot:driver.snapshot(),progress:prog,resource:res,
   chosen:prev?prev.chosen:0,fails:prev?prev.fails:0,found:Date.now()});
  if(prog>bestProgress||(prog===bestProgress&&bestCell&&res>bestCell.resource)){bestProgress=prog;bestCell=cells.get(k);}
  return true;
 }
 function choose(){
  let best=null,bestScore=-Infinity;
  for(const c of cells.values()){
   const score=c.progress-bestProgress+3/Math.sqrt(c.chosen+1)-0.5*c.fails+random()*0.5;
   if(score>bestScore){bestScore=score;best=c;}
  }
  return best;
 }
 function explore(){
  const c=choose();if(!c)return null;
  c.chosen++;explorations++;
  driver.restore(c.snapshot);
  const horizon=o.horizons[Math.floor(random()*o.horizons.length)];
  const trace=c.trace.slice();let frames=0,added=0,lost=false;
  let mask=o.actions[Math.floor(random()*o.actions.length)],left=0;
  const start=o.readResource(driver.readRam());
  while(frames<horizon){
   if(left<=0){mask=o.actions[Math.floor(random()*o.actions.length)];left=o.holdMin+Math.floor(random()*(o.holdMax-o.holdMin+1));}
   driver.run(mask,o.stride);frames+=o.stride;framesRun+=o.stride;trace.push(mask);left--;
   const ram=driver.readRam();
   if(o.readResource(ram)<start){lost=true;break;}
   if(offer(trace,ram))added++;
  }
  if(!added)c.fails++;
  return {from:c.key,horizon,frames,added,lost};
 }
 /* start: the legal start state (trace empty) */
 offer([],driver.readRam());
 return {revision:EXPLORE_REVISION,explore,
  stats:()=>({cells:cells.size,explorations,framesRun,bestProgress,bestResource:bestCell?bestCell.resource:null,bestTraceLength:bestCell?bestCell.trace.length:0}),
  best:()=>bestCell?{trace:bestCell.trace.slice(),progress:bestCell.progress,resource:bestCell.resource,snapshot:bestCell.snapshot}:null,
  cells:()=>cells};
}

const api=Object.freeze({EXPLORE_REVISION,DEFAULTS,createArchive});
root.FlyAgodExplore=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
