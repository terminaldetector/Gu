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
const EXPLORE_REVISION='agod-explore-r3';
const DEFAULTS=Object.freeze({stride:8,horizons:Object.freeze([96,192,384]),holdMin:1,holdMax:4,
 progressBucket:4,positionBucket:16,screenLevels:3,seed:1,
 /* allowLoss: a branch goes on through a loss of the resource (a respawn) and
    stops only at the floor; the resource is part of the cell, so a route that
    keeps more of it to the same place always replaces a costlier one. Without
    it a branch stops at the first loss - a frontier behind an unavoidable hit
    is then never crossed (measured on a private SNES run-and-gun: stuck at
    progress 176 after 100 000 frames). lifeWeight: how much progress one unit
    of resource is worth when choosing where to explore from. */
 allowLoss:false,floor:0,lifeWeight:8,
 /* maxCells: a bound on the archive (each cell holds a savestate). Past it the
    cells worth least - lowest progress plus resource, then most often chosen -
    are dropped, a tenth at a time; the start and the best cell never are. */
 maxCells:Infinity,
 /* unwrap: progress is what a trajectory has GAINED. A progress counter that falls
    from its upper half to under a quarter of that value while in play has wrapped
    or been reset for the next segment (measured on a private SNES run-and-gun: two
    per-segment scroll counters climb to 255 and restart at 0 where the screen locks
    at a fortified wall, so the archive saw the next segment as 510 progress lower
    and never explored it); the trajectory keeps what it had and counts on. Any
    other fall is taken as it is. */
 unwrap:true,
 /* select: 'frontier' scores a cell by its distance to the best progress (lives
    weighted by lifeWeight); 'lives' by its distance to the best progress reached
    WITH THE SAME resource, so the archive pushes one frontier per number of lives
    left instead of reaching every obstacle on its last one (on a private SNES
    run-and-gun the frontier routes met a mid-boss with one life after two early
    deaths). It spreads the effort over the lives counts: on the synthetic gated
    stage it is slower than 'frontier' (93 768 against 1 576 frames). */
 select:'frontier',
 /* damage: when the frontier has not moved for probeEvery explorations, AGOD probes
    the best cell CAUSALLY - from the same state, "press nothing" for probeStrides
    strides, then the action set (probeRounds random runs) - and keeps as DAMAGE
    COUNTERS the bytes that fall in small steps (<= damageStep) only when the player
    acts, and never rise in either branch (strides around a resource loss ignored).
    What a trajectory has made them fall is part of its cell (damageBucket) and of
    its progress (damageWeight per unit), so a fight a single exploration cannot
    finish is kept half won. Measured on a private SNES run-and-gun: a mid-boss
    whose health byte falls only under fire needs ~60 strides of hits, an
    exploration on the last life survives ~20, and the archive stood still for
    millions of frames without it. */
 damage:false,damageWeight:1,damageBucket:4,damageStep:16,probeEvery:200,probeStrides:16,probeRounds:3});

/* per trajectory: raw progress values -> accumulated ones (see DEFAULTS.unwrap) */
function unwrapStep(track,raw,enabled){
 const off=track?track.off.slice():raw.map(()=>0),last=track?track.last.slice():raw.slice(),dmg=track&&track.dmg||0;
 for(let i=0;i<raw.length;i++){const v=raw[i],p=last[i];
  if(enabled&&Number.isFinite(v)&&Number.isFinite(p)&&p>=128&&v*4<=p)off[i]+=p;
  if(Number.isFinite(v))last[i]=v;}
 return {off,last,dmg,value:raw.map((v,i)=>Number.isFinite(v)?v+off[i]:v)};
}
function rng(seed){let s=seed>>>0||1;return()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};}

/* THE CELL KEY, shared by the archive and by FDB's skill memory (distillation), so
   both name a state the same way: progress fields (bucketed), controlled position
   (bucketed), resource, coarse screen. Nothing game-specific. */
function cellKey(o,ram,scr,progressValues){
 const prog=(progressValues||o.readProgress(ram)||[]).map(v=>Number.isFinite(v)?Math.floor(v/o.progressBucket):-1);
 const pos=(o.positionFields||[]).map(a=>Math.floor(ram[a]/o.positionBucket));
 let s='';if(scr)for(let i=0;i<scr.length;i++)s+=Math.min(o.screenLevels-1,Math.floor(scr[i]*o.screenLevels));
 return prog.join(',')+'|'+pos.join(',')+'|'+o.readResource(ram)+'|'+s;
}
/* a keyer with VISIT and DWELL: how many times this cell was entered before in the
   episode, and how many consecutive strides the state has stayed in it (capped).
   A route that comes back to a cell, or crosses it with several actions, is told
   apart by its own history in the episode - not by the clock. Measured: without the
   visit count 548 route steps gave 494 keys, later visits overwrote earlier ones
   and a frozen run left the route at decision 10. */
function createKeyer(options){
 const o={...DEFAULTS,...(options||{})};let last=null,dwell=0;const visits=new Map();
 return {key(ram,scr){const k=cellKey(o,ram,scr);
   if(k===last)dwell=Math.min(31,dwell+1);else{last=k;dwell=0;visits.set(k,(visits.get(k)||0)+1);}
   return k+'#'+visits.get(k)+'.'+dwell;},
  reset(){last=null;dwell=0;visits.clear();}};
}

/* options: {actions:[masks], readProgress(ram)->[numbers], readResource(ram)->number,
   positionFields:[addresses], screen()->Float32Array|null, ...DEFAULTS} */
function createArchive(driver,options){
 const o={...DEFAULTS,...(options||{})};
 const random=rng(o.seed);
 const cells=new Map();let explorations=0,framesRun=0,bestProgress=-Infinity,bestCell=null,evicted=0;const bestByResource=new Map();
 const damageAddrs=new Set(),probed=new Set();let probes=0,lastImprove=0;
 const dealt=(before,after)=>{let d=0;for(const a of damageAddrs){const f=before[a]-after[a];if(f>0&&f<=o.damageStep)d+=f;}return d;};
 const total=v=>v.reduce((s,x)=>s+(Number.isFinite(x)?x:0),0);
 function offer(trace,ram,track){
  const dmg=o.damage?track.dmg||0:0;
  const k=cellKey(o,ram,o.screen?o.screen():null,track.value)+(o.damage?'|d'+Math.floor(dmg/o.damageBucket):''),prog=total(track.value)+o.damageWeight*dmg,res=o.readResource(ram);
  const prev=cells.get(k);
  if(prev&&(prev.resource>res||(prev.resource===res&&prev.trace.length<=trace.length)))return false;
  cells.set(k,{key:k,trace:trace.slice(),snapshot:driver.snapshot(),progress:prog,resource:res,track,
   chosen:prev?prev.chosen:0,fails:prev?prev.fails:0,found:Date.now()});
  if(!(bestByResource.get(res)>=prog))bestByResource.set(res,prog);
  if(res>o.floor||!o.allowLoss)if(prog>bestProgress||(prog===bestProgress&&bestCell&&res>bestCell.resource)){if(prog>bestProgress)lastImprove=explorations;bestProgress=prog;bestCell=cells.get(k);}
  if(cells.size>o.maxCells)evict();
  return true;
 }
 /* with select 'lives' a cell is worth its distance to the frontier of its own
    resource, so a frontier with more lives left is not evicted for being behind */
 const worth=c=>o.select==='lives'?c.progress-(bestByResource.get(c.resource)||0):c.progress+(o.allowLoss?o.lifeWeight*c.resource:0);
 function evict(){
  const drop=Math.max(1,Math.ceil(cells.size-o.maxCells*0.9));
  const order=[...cells.values()].filter(c=>c!==bestCell&&c.trace.length>0)
   .sort((x,y)=>(worth(x)-worth(y))||(y.chosen-x.chosen));
  for(let i=0;i<drop&&i<order.length;i++)cells.delete(order[i].key);
  evicted+=Math.min(drop,order.length);
 }
 function choose(){
  let best=null,bestScore=-Infinity;
  for(const c of cells.values()){
   if(o.select==='lives'&&o.allowLoss&&c.resource<=o.floor)continue;
   const gap=o.select==='lives'?c.progress-bestByResource.get(c.resource):c.progress-bestProgress+(o.allowLoss?o.lifeWeight*c.resource:0);
   const score=gap+3/Math.sqrt(c.chosen+1)-0.5*c.fails+random()*0.5;
   if(score>bestScore){bestScore=score;best=c;}
  }
  return best;
 }
 /* the causal damage probe (see DEFAULTS.damage) */
 function probe(c){probes++;probed.add(c.key);
  const run=pick=>{driver.restore(c.snapshot);const falls=new Map(),rises=new Set();let prev=driver.readRam(),quiet=0;const r0=o.readResource(prev);
   for(let k=0;k<o.probeStrides;k++){driver.run(pick(k),o.stride);framesRun+=o.stride;const ram=driver.readRam();
    if(o.readResource(ram)<o.readResource(prev))quiet=4;
    if(quiet>0)quiet--;else for(let a=0;a<ram.length;a++){const f=prev[a]-ram[a];if(f>0&&f<=o.damageStep)falls.set(a,(falls.get(a)||0)+1);else if(f<0)rises.add(a);}
    prev=ram;if(o.readResource(ram)<r0&&(!o.allowLoss||o.readResource(ram)<=o.floor))break;}
   return {falls,rises};};
  const idle=run(()=>0),acted=[];
  for(let r=0;r<o.probeRounds;r++){let m=0,left=0;acted.push(run(()=>{if(left<=0){do m=o.actions[Math.floor(random()*o.actions.length)];while(m===0&&o.actions.length>1);left=o.holdMin+Math.floor(random()*(o.holdMax-o.holdMin+1));}left--;return m;}));}
  let found=0;const cand=new Map();for(const x of acted)for(const [a,n] of x.falls)cand.set(a,(cand.get(a)||0)+n);
  for(const [a,n] of cand)if(n>=2&&!idle.falls.has(a)&&!idle.rises.has(a)&&acted.every(x=>!x.rises.has(a))&&!damageAddrs.has(a)){damageAddrs.add(a);found++;}
  lastImprove=explorations;return found;}
 function explore(){
  if(o.damage&&explorations-lastImprove>=o.probeEvery){let target=null;for(const c of cells.values())if(!probed.has(c.key)&&(c.resource>o.floor||!o.allowLoss)&&(!target||c.progress>target.progress))target=c;if(target)probe(target);else lastImprove=explorations;}
  const c=choose();if(!c)return null;
  c.chosen++;explorations++;
  driver.restore(c.snapshot);
  const horizon=o.horizons[Math.floor(random()*o.horizons.length)];
  const trace=c.trace.slice();let frames=0,added=0,lost=false,track=c.track;
  let mask=o.actions[Math.floor(random()*o.actions.length)],left=0;
  const start=o.readResource(driver.readRam());
  while(frames<horizon){
   if(left<=0){mask=o.actions[Math.floor(random()*o.actions.length)];left=o.holdMin+Math.floor(random()*(o.holdMax-o.holdMin+1));}
   const before=o.damage?driver.readRam():null;
   driver.run(mask,o.stride);frames+=o.stride;framesRun+=o.stride;trace.push(mask);left--;
   const ram=driver.readRam();
   const res=o.readResource(ram);
   if(res<start){lost=true;if(!o.allowLoss||res<=o.floor)break;}
   track=unwrapStep(track,o.readProgress(ram)||[],o.unwrap);
   if(o.damage&&damageAddrs.size)track.dmg+=dealt(before,ram);
   if(offer(trace,ram,track))added++;
  }
  if(!added)c.fails++;
  return {from:c.key,horizon,frames,added,lost};
 }
 /* start: the legal start state (trace empty) */
 {const ram=driver.readRam();offer([],ram,unwrapStep(null,o.readProgress(ram)||[],o.unwrap));}
 const startCell=[...cells.values()][0];
 /* SEED ROUTE: a route found earlier, replayed from the legal start; every stride is
    offered as if explored, so the search continues from it (a route found later is
    still one action trace from the legal start) */
 function seedRoute(masks){driver.restore(startCell.snapshot);let track=startCell.track;const trace=[];let added=0;
  for(const mask of masks){const before=driver.readRam();driver.run(mask,o.stride);framesRun+=o.stride;trace.push(mask);const ram=driver.readRam();
   if(o.allowLoss?o.readResource(ram)<=o.floor:false)break;
   track=unwrapStep(track,o.readProgress(ram)||[],o.unwrap);if(o.damage&&damageAddrs.size)track.dmg+=dealt(before,ram);if(offer(trace,ram,track))added++;}
  return {strides:trace.length,added};}
 return {revision:EXPLORE_REVISION,explore,seedRoute,
  stats:()=>({cells:cells.size,evicted,explorations,framesRun,damageCounters:damageAddrs.size,probes,frontierByResource:Object.fromEntries([...bestByResource].sort((a,b)=>a[0]-b[0])),bestProgress,bestResource:bestCell?bestCell.resource:null,bestTraceLength:bestCell?bestCell.trace.length:0}),
  best:()=>bestCell?{trace:bestCell.trace.slice(),progress:bestCell.progress,resource:bestCell.resource,snapshot:bestCell.snapshot}:null,
  cells:()=>cells};
}

const api=Object.freeze({EXPLORE_REVISION,DEFAULTS,createArchive,cellKey,createKeyer,unwrapStep});
root.FlyAgodExplore=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
