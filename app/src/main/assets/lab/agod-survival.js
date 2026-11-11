/* AGOD survival discovery: what a real game takes away, and what it pays.

   THE DEFECT THIS ANSWERS, measured on two private Mega Drive cartridges. The
   pipeline's resource stage asks "which button, pressed repeatedly, drives a
   field to a floor, compared with doing nothing". That is the right question
   for a cartridge whose cost is an action. In a commercial game the cost is
   the GAME: enemies hit the player whether or not a button is pressed, so the
   neutral control loses health too, the real resource moves in the control
   arm, and the stage excludes it as time-driven. On the first cartridge the
   pipeline refused at `induce` from the title AND from live play, both times
   after 12371 frames, while its health byte fell 4,3,2,1,0 in front of it.

   THE CONTROL THAT REPLACES "NEUTRAL" HERE. Not "did the action do it" but
   "did WHAT THE PLAYER DID change WHEN it happened":

     clock        a field whose decrements land on the same frames under every
                  policy is a timer, not a hazard, and is never a resource;
     hazard       a field whose decrements land on DIFFERENT frames under
                  different policies, from the same snapshot of a
                  deterministic emulator, is modulated by the player's input -
                  the only thing that differed between the runs;
     terminal     the field is at its floor when control of the game is lost
                  for good, in independent runs, and was not at its floor in
                  runs that did not end.

   "Control" is the integrator test from agod-phase.js re-run along each
   rollout from a snapshot, so the check never perturbs the trajectory it
   observes. A short loss of control is a gap (a death and respawn, a stage
   change); a sustained one is terminal.

   PROGRESS. A field that rises while the player is in control, never falls
   during control except as a digit carry, and does not rise when the player
   does nothing, is something the player EARNS. It is reported as progress for
   the PROVISIONAL tier only; it is not a verified positive polarity.

   PARTITIONS BY ORIGIN. Discovery runs from the given state. Calibration and
   holdout run from states reached by separate, seeded random play from it, so
   each partition has its own parent state and restore path, and the evidence
   registry enforces that no start serves two partitions.

   NOTHING HERE IS ORACLE. No ROM name, no header, no RAM map, no human route.
   Platform-independent: restore / run / readRam / snapshot / stateHash and the
   driver's action specification. */
(function(root){'use strict';
const require_=typeof require==='function'?require:null;
const Phase=root.FlyAgodPhase||(require_?require_('./agod-phase.js'):null);
const Evidence=root.FlyAgodEvidence||(require_?require_('./agod-evidence.js'):null);
const Reward=root.FlyAgodReward||(require_?require_('./agod-reward.js'):null);
const Ram=root.FlyAgodRam||(require_?require_('./agod-ram.js'):null);

const SURVIVAL_REVISION='agod-pipeline-survival-r1';
const DEFAULTS=Object.freeze({
 stride:8,                 /* RAM is compared every this many frames */
 checkEvery:64,            /* control is re-tested every this many frames */
 checkHold:6,checkSettle:6,controlMinBytes:4,
 terminalLossFrames:300,   /* control lost this long is a candidate ending */
 terminalConfirmFrames:900,/* ...and it is an ending if control has not come back this much later */
 deathGapFrames:96,        /* a gap at least this long is a loss of life, not a stumble */
 horizon:3600,
 discoveryPolicies:6,      /* neutral + this many-1 seeded random policies */
 verifyPolicies:3,
 calibrationLead:90, holdoutLead:180,
 linkWindow:420,           /* the floor must be reached this close to terminal */
 maxEventsPerAddress:40,
 maxProgressFields:4,
 frameBudget:220000});

const frozen=Object.freeze.bind(Object);
const PAUSE_NAMES=new Set(['Start','Select','Mode']);

function rng(seed){let s=(seed>>>0)||1;return ()=>{s=(Math.imul(s,1103515245)+12345)>>>0;return s/4294967296;};}

/* A random player: a direction (or none) and each action button with its own
   probability, re-drawn every stride. Pause/menu buttons are never pressed:
   which buttons those are comes from the platform's pad description. */
function randomPolicy(spec,seed){
 const r=rng(seed);
 const axes=Phase.axesOf(spec);
 const dirs=[0];
 for(const a of axes){dirs.push(a.neg,a.pos);}
 if(axes.length===2)for(const x of [axes[0].neg,axes[0].pos])for(const y of [axes[1].neg,axes[1].pos])dirs.push(x|y);
 const buttons=Phase.buttonsOf(spec).filter(b=>!PAUSE_NAMES.has(b.name));
 const odds=buttons.map((b,i)=>0.5/(1+i*0.6));
 return ()=>{let m=dirs[Math.floor(r()*dirs.length)];buttons.forEach((b,i)=>{if(r()<odds[i])m|=b.mask;});return m;};
}

/* Is the player in control right now? From a snapshot, hold one direction of
   the controlled axis, then the other, release both and let them settle: in
   play the two arms leave the machine in different states (the player is
   somewhere else); in a menu, a cut-scene or a death animation they leave it
   in the same state, or differ only in a cursor byte. No particular byte has
   to be found again: an on-screen x coordinate stops moving while the screen
   scrolls, which made the first version of this test report the scrolling
   stretches of a run-and-gun stage as lost control. */
function controlTester(driver,probe,cfg){
 const drive=Phase.driverFor(driver,cfg.port);
 const ax=(probe.axes||[]).filter(a=>a.integrators>0).sort((a,b)=>b.integrators-a.integrators)[0]
  ||(probe.axes||[])[0]||null;
 const axis=ax?{pos:ax.pos,neg:ax.neg,name:ax.axis}:null;
 return {
  axis:()=>axis&&axis.name,
  test(){
   if(!axis)return false;
   const s=driver.snapshot();
   drive(axis.pos,cfg.checkHold);drive(0,cfg.checkSettle);const p=driver.readRam();
   driver.restore(s);drive(axis.neg,cfg.checkHold);drive(0,cfg.checkSettle);const q=driver.readRam();
   driver.restore(s);
   let differ=0;
   for(let i=0;i<p.length;i++)if(p[i]!==q[i]&&++differ>=cfg.controlMinBytes)return true;
   return false;
  },
  cost:()=>2*(cfg.checkHold+cfg.checkSettle)};
}

/* One rollout. Returns change events per address (capped), control segments
   and the terminal time. The trajectory is never touched by the control
   checks: each is run from a snapshot and restored. */
function rollout(driver,start,policy,control,cfg,meter){
 const drive=Phase.driverFor(driver,cfg.port);
 driver.restore(start);
 const width=driver.readRam().length;
 const E=cfg.maxEventsPerAddress;
 const count=new Uint8Array(width),busy=new Uint8Array(width);
 const events=new Int32Array(width*E);
 let prev=driver.readRam();
 const v0=prev.slice();
 const checks=[];             /* [t, controlled] */
 let lostSince=null,terminal=null,t=0,ending=null;
 while(t<cfg.horizon||lostSince!==null){
  if(t%cfg.checkEvery===0){
   const ok=control.test();meter.frames+=control.cost();
   checks.push([t,ok?1:0]);
   if(!ok&&lostSince===null)lostSince=t;
   if(ok)lostSince=null;
   /* A long loss of control is an ending only if the game says so: it shows
      a screen that a button advances (game over, continue, title), or control
      does not come back at all. A boss introduction or a stage change gives
      control back, and is a gap. */
   if(lostSince!==null&&t-lostSince>=cfg.terminalLossFrames){
    if(ending===null){
     const p=Phase.probe(driver,{port:cfg.port});meter.frames+=p.framesUsed;
     ending=p.phase;
     if(p.phase==='MENU'){terminal=lostSince;break;}
    }
    if(t-lostSince>=cfg.terminalLossFrames+cfg.terminalConfirmFrames){terminal=lostSince;break;}
   }
   if(lostSince===null)ending=null;
  }
  if(t>=cfg.horizon&&lostSince===null)break;
  drive(policy(t),cfg.stride);meter.frames+=cfg.stride;t+=cfg.stride;
  const cur=driver.readRam();
  for(let a=0;a<width;a++){
   if(cur[a]===prev[a]||busy[a])continue;
   const c=count[a];
   if(c>=E){busy[a]=1;continue;}
   events[a*E+c]=(t<<16)|(prev[a]<<8)|cur[a];count[a]=c+1;
  }
  prev=cur;
 }
 /* control segments: maximal runs of lost checks */
 const gaps=[];let g=null;
 for(const [ct,ok] of checks){
  if(!ok&&g===null)g=[ct,null];
  if(ok&&g!==null){g[1]=ct;gaps.push(g);g=null;}
 }
 if(g!==null&&terminal===null){g[1]=t;gaps.push(g);}
 const inControlAt=time=>{
  let state=1;for(const [ct,ok] of checks){if(ct>time)break;state=ok;}return state===1;};
 const kept=gaps.filter(x=>terminal===null||x[0]<terminal);
 /* losses of life: long gaps, and the ending itself */
 const losses=kept.filter(x=>x[1]-x[0]>=cfg.deathGapFrames).map(x=>({start:x[0],end:x[1],kind:'gap'}));
 if(terminal!==null)losses.push({start:terminal,end:t,kind:'terminal'});
 return {terminal,end:t,gaps:kept,losses,endingPhase:terminal!==null?ending:null,
  count,busy,events,E,v0,last:prev,width,inControlAt,lossFrames:cfg.terminalLossFrames,stride:cfg.stride};
}

function eventsOf(run,a){
 const out=[];
 for(let i=0;i<run.count[a];i++){const e=run.events[a*run.E+i];
  out.push({t:e>>>16,from:(e>>>8)&255,to:e&255});}
 return out;
}
/* A digit carry: this byte fell at the same sample its neighbour rose by
   exactly one. A struct being rewritten moves its neighbours too, but by
   arbitrary amounts, so "exactly one" is what keeps a score's low digit and
   rejects an object table. */
const carryPartner=(run,a,t)=>{
 for(const b of [a-1,a+1]){
  if(b<0||b>=run.width||run.busy[b])continue;
  for(const e of eventsOf(run,b))if(e.t===t&&e.to===e.from+1)return b;
 }
 return null;
};
/* Read a byte as signed when it is seen crossing zero downwards: a counter
   that goes 1, 0, 255 has gone to -1, it has not gained 255. Decided per
   address from what the discovery runs saw, and carried into the profile so
   the live reward reads it the same way. */
function signedAddress(runs,a){
 for(const r of runs)for(const e of eventsOf(r,a))if(e.from<16&&e.to>=240)return true;
 return false;
}
const asValue=(x,signed)=>signed&&x>127?x-256:x;

/* the per-address facts one rollout supports */
function summarise(run,a,signed){
 const ev=eventsOf(run,a);
 const end=run.end;
 const facts={decControl:[],decAll:[],incControl:0,decGap:0,incGap:0,carryDec:0,carryAll:0,
  carryPartners:new Set(),valueAtTerminal:null,valueAtEnd:null,min:asValue(run.v0[a],signed)};
 let value=asValue(run.v0[a],signed);
 for(const e of ev){
  if(e.t>end)break;
  const from=asValue(e.from,signed),to=asValue(e.to,signed);
  value=to;if(value<facts.min)facts.min=value;
  const control=run.inControlAt(e.t-1);
  if(to<from){
   /* a hit often costs control for a moment (knock-back, invulnerability
      flashing), so a loss inside a short gap is still a loss */
   const partner=carryPartner(run,a,e.t);
   if(partner!==null){facts.carryAll++;facts.carryPartners.add(partner);if(control)facts.carryDec++;}
   else{facts.decAll.push(e.t);if(control)facts.decControl.push(e.t);else facts.decGap++;}
  }else{if(control)facts.incControl++;else facts.incGap++;}
 }
 facts.valueAtEnd=value;
 if(run.terminal!==null){
  let v=asValue(run.v0[a],signed);for(const e of ev){if(e.t>run.terminal)break;v=asValue(e.to,signed);}
  facts.valueAtTerminal=v;
 }
 facts.lastDec=facts.decAll.length?facts.decAll[facts.decAll.length-1]:null;
 return facts;
}

function candidatesFrom(runs,controlFields,cfg){
 const width=runs[0].width;
 const resource=[],progress=[];
 const skip=new Set(controlFields);
 for(let a=0;a<width;a++){
  if(skip.has(a)||runs.some(r=>r.busy[a]))continue;
  if(!runs.some(r=>r.count[a]))continue;
  const signed=signedAddress(runs,a);
  const facts=runs.map(r=>summarise(r,a,signed));
  /* ---- resource ----
     Linked to an ending: in a run that ended, the field fell in play, its last
     fall came within linkWindow of the loss of control (or during it), and
     by the time the ending was certain it sat at the lowest value any run
     ever saw. A run that ended with the field above that floor contradicts. */
  const floor=Math.min(...facts.map(f=>f.min));
  const terminalRuns=runs.map((r,i)=>i).filter(i=>runs[i].terminal!==null);
  let linked=0,contradicted=0;
  for(const i of terminalRuns){
   const f=facts[i],T=runs[i].terminal;
   const atFloor=f.valueAtEnd===floor;
   const recent=f.lastDec!==null&&f.lastDec>=T-cfg.linkWindow&&f.lastDec<=runs[i].end;
   /* and it fell BEFORE the ending began: a fade-out or a game-over
      animation counts down after control is gone, a resource runs out
      while the player still has it */
   const fellInPlay=f.decAll.some(t=>t<T);
   if(atFloor&&recent&&fellInPlay&&f.incControl===0)linked++;
   else if(!atFloor)contradicted++;
  }
  /* KIND B, per death. Every fall of the field lies at a loss of life (a long
     gap or the ending), and most losses of life take one: a lives counter. A
     health bar that refills at respawn fails "every fall", a lives counter
     that waits for the ending fails nothing. */
  let explained=0,unexplained=0,stray=0;
  runs.forEach((r,i)=>{
   const f=facts[i];
   for(const loss of r.losses){
    const hit=f.decAll.some(t=>t>=loss.start-cfg.checkEvery&&t<=loss.end+cfg.checkEvery);
    if(hit)explained++;else unexplained++;
   }
   for(const t of f.decAll)
    if(!r.losses.some(loss=>t>=loss.start-cfg.checkEvery&&t<=loss.end+cfg.checkEvery))stray++;
  });
  const timings=new Set(facts.map(f=>f.decAll.join('/')));
  const decRuns=facts.filter(f=>f.decAll.length).length;
  const clock=decRuns>=2&&timings.size===1;
  const initial=asValue(runs[0].v0[a],signed);
  const risesInPlay=facts.reduce((s,f)=>s+f.incControl,0);
  /* a counter that falls one at a time (lives, hearts) says more than a byte
     that jumps (a pointer, a state code) - used to break ties only */
  let unitSteps=true;
  for(const r of runs)for(const e of eventsOf(r,a)){const from=asValue(e.from,signed),to=asValue(e.to,signed);
   if(to<from&&from-to!==1&&carryPartner(r,a,e.t)===null)unitSteps=false;}
  const base={address:a,signed,floor,initial,unitSteps,policyDependentTiming:timings.size>1,
   decrementsBeforeTerminal:facts.reduce((s,f)=>s+f.decAll.length,0),
   decrementTimes:facts.map(f=>f.decAll.slice(0,8))};
  if(linked>=2&&!clock&&initial>floor)
   resource.push({...base,kind:'TERMINAL',linked,contradicted,terminalRuns:terminalRuns.length});
  else if(explained>=2&&stray===0&&risesInPlay===0&&!clock&&initial>floor&&explained>=2*unexplained)
   resource.push({...base,kind:'PER_LOSS',linked:explained,contradicted:unexplained,terminalRuns:terminalRuns.length});
  /* ---- progress ---- */
  const rises=facts.map(f=>f.incControl);
  const falls=facts.reduce((s,f)=>s+f.decAll.length,0);
  const risingRuns=rises.filter(x=>x>0).length;
  /* earned: rises in play under most active policies, never under neutral,
     never falls before the end except as a digit carry */
  if(falls===0&&risingRuns>=Math.max(2,Math.ceil((runs.length-1)*0.6))&&rises[0]===0){
   const partners=new Set();facts.forEach(f=>f.carryPartners.forEach(x=>partners.add(x)));
   progress.push({address:a,risingRuns,rises,neutralRises:rises[0],
    carries:facts.reduce((s,f)=>s+f.carryAll,0),carryPartners:[...partners]});
  }
 }
 /* the stronger evidence first: linked in more runs; then the field that falls
    in more steps (a health bar says more than a dead flag); then fewer
    contradictions */
 resource.sort((x,y)=>((x.kind==='TERMINAL'?0:1)-(y.kind==='TERMINAL'?0:1))||(y.linked-x.linked)||(x.contradicted-y.contradicted)
  ||((y.unitSteps?1:0)-(x.unitSteps?1:0))||(y.decrementsBeforeTerminal-x.decrementsBeforeTerminal)||(x.address-y.address));
 progress.sort((x,y)=>(y.risingRuns-x.risingRuns)||(y.rises.reduce((s,v)=>s+v,0)-x.rises.reduce((s,v)=>s+v,0))||(x.address-y.address));
 return {resource,progress};
}

/* Progress fields as the profile reads them: a byte whose carries go into a
   neighbour becomes a two-byte word with that neighbour, so a wrap of the low
   byte is read as the gain it is and not as a loss. */
function progressFieldsFrom(candidates,limit,width){
 const out=[],taken=new Set();
 for(const c of candidates){
  if(out.length>=limit)break;
  let field;
  const hi=c.carryPartners.length===1?c.carryPartners[0]:null;
  if(hi!==null&&hi===c.address-1)field={address:hi,width:2,endian:'big'};
  else if(hi!==null&&hi===c.address+1)field={address:c.address,width:2,endian:'little'};
  else field={address:c.address,width:1,endian:'n/a'};
  if(field.address<0||field.address+field.width>width)continue;
  let overlap=false;for(let k=0;k<field.width;k++)if(taken.has(field.address+k))overlap=true;
  if(overlap)continue;
  for(let k=0;k<field.width;k++)taken.add(field.address+k);
  out.push(frozen({...field,encoding:'binary',encodingDetermined:true,mask:null,
   basis:'rose in play under '+c.risingRuns+' policies, never under neutral, never fell in play except as a carry'}));
 }
 return out;
}

/* One verification start: does the chosen field behave as the resource the
   discovery runs said it was? */
function verdictFor(runs,chosen,cfg){
 const {address,floor,signed,kind}=chosen;
 let losses=0,linked=0,explained=0,unexplained=0;const contradictions=[];
 for(const r of runs){
  const f=summarise(r,address,signed);
  losses+=f.decAll.length;
  if(r.terminal!==null){
   if(f.valueAtEnd===floor)linked++;
   else if(kind==='TERMINAL')contradictions.push('the game ended at frame '+r.terminal
    +' while the field read '+f.valueAtEnd+', above its floor '+floor);
  }
  if(kind==='PER_LOSS'){
   for(const loss of r.losses){
    if(f.decAll.some(t=>t>=loss.start-cfg.checkEvery&&t<=loss.end+cfg.checkEvery))explained++;else unexplained++;
   }
   for(const t of f.decAll)
    if(!r.losses.some(loss=>t>=loss.start-cfg.checkEvery&&t<=loss.end+cfg.checkEvery))
     contradictions.push('the field fell at frame '+t+' with no loss of life there');
  }
 }
 if(kind==='PER_LOSS'&&unexplained>explained&&explained+unexplained>=2)
  contradictions.push(unexplained+' losses of life left the field untouched, '+explained+' took one');
 if(contradictions.length)return {outcome:'contradicted',losses,linked,explained,unexplained,contradictions};
 if(losses===0)return {outcome:'inconclusive',losses,linked,explained,unexplained,contradictions};
 return {outcome:'confirmed',losses,linked,explained,unexplained,contradictions};
}
/* progress must not fall in play from the verification starts either: every
   fall of a member byte has to be the low byte of the field wrapping while
   its high byte rises by one */
function progressHolds(runs,field){
 for(const r of runs)for(let k=0;k<field.width;k++){
  const a=field.address+k;
  const isLow=field.width===2&&((field.endian==='big'&&k===1)||(field.endian==='little'&&k===0));
  const other=field.address+(1-k);
  for(const e of eventsOf(r,a)){
   if(r.terminal!==null&&e.t>r.terminal)break;
   if(e.to>=e.from)continue;
   const carried=isLow&&eventsOf(r,other).some(x=>x.t===e.t&&x.to===x.from+1);
   if(!carried)return false;
  }
 }
 return true;
}

/* A verification start of its own: seeded random play from the given state,
   continued in short steps until the phase probe sees play again (a lead-in
   that ends in hit-stun is extended, not used). */
function lead(driver,from,spec,seed,frames,meter,port){
 const drive=Phase.driverFor(driver,port);
 driver.restore(from);const p=randomPolicy(spec,seed);
 let t=0;
 for(;t<frames;t+=8)drive(p(t),8);
 meter.frames+=frames;
 for(let tries=0;tries<8;tries++){
  const probe=Phase.probe(driver,{port});meter.frames+=probe.framesUsed;
  if(probe.phase==='PLAYING')return {snapshot:driver.snapshot(),probe,frames:t};
  for(let k=0;k<3;k++,t+=8)drive(p(t),8);
  meter.frames+=24;
 }
 return {snapshot:driver.snapshot(),probe:null,frames:t};
}

function discover(driver,options){
 const cfg={...DEFAULTS,...(options||{})};
 const trace=[];
 const note=(stage,detail)=>trace.push({stage,...detail});
 const refuse=(stage,reason,detail)=>frozen({schemaVersion:1,pipelineRevision:SURVIVAL_REVISION,
  status:'REFUSED',stage,reason,goal:null,actions:null,discovered:detail&&detail.discovered||null,
  trace,refusals:[{stage,reason}]});
 for(const [n,m] of [['agod-phase',Phase],['agod-evidence',Evidence],['agod-reward',Reward],['agod-ram',Ram]])
  if(!m)return refuse('wiring','a required module is missing: '+n);
 for(const k of ['romHash','coreRevision','profileRevision'])
  if(typeof cfg[k]!=='string'||!cfg[k])return refuse('wiring',k+' is required');
 const spec=driver.actionSpec;
 const meter={frames:0};
 const t0=Date.now();
 const start=driver.snapshot();
 const startHash=driver.stateHash();
 const port=cfg.port===2?2:1;
 const probe=Phase.probe(driver,{port});meter.frames+=probe.framesUsed;
 note('phase',{port,phase:probe.phase,controlledAxes:probe.controlledAxes});
 if(probe.phase!=='PLAYING')
  return refuse('phase','the start state is not in play ('+probe.phase+'): a survival '
   +'search from a menu or a cut-scene would measure the menu');
 const control=controlTester(driver,probe,cfg);
 const controlFields=[...new Set((probe.axes||[]).flatMap(a=>a.fields||[]))];
 const policies=[{name:'neutral',seed:0,make:()=>()=>0}];
 for(let k=1;k<cfg.discoveryPolicies;k++)policies.push({name:'random-'+k,seed:k,make:()=>randomPolicy(spec,k)});
 const runs=[];
 for(const pol of policies){
  if(meter.frames>cfg.frameBudget)return refuse('budget','the frame budget ran out during discovery',{});
  const r=rollout(driver,start,pol.make(),control,cfg,meter);
  runs.push(r);
  note('rollout',{partition:'DISCOVERY',policy:pol.name,terminal:r.terminal,end:r.end,gaps:r.gaps.length,
   losses:r.losses.length,endingPhase:r.endingPhase});
 }
 const found=candidatesFrom(runs,controlFields,cfg);
 const survival=runs.map((r,i)=>({policy:policies[i].name,terminal:r.terminal,end:r.end,gaps:r.gaps.length,losses:r.losses.length}));
 const discovered={resourceCandidates:found.resource.slice(0,6),progressCandidates:found.progress.slice(0,8),
  controlFields,survival};
 note('candidates',{resource:found.resource.length,progress:found.progress.length,
  terminalRuns:runs.filter(r=>r.terminal!==null).length});
 if(!found.resource.length){
  const terminalRuns=runs.filter(r=>r.terminal!==null).length;
  return refuse('resource',terminalRuns<2
   ?'control was lost for good in '+terminalRuns+' of '+runs.length+' runs within the horizon; a terminal resource needs at least two endings to be linked to'
   :'no field was at its floor at the end of at least two runs after falling in play',{discovered});
 }
 const chosen=found.resource[0];
 /* ---- calibration and holdout, from starts of their own ---- */
 const goalId='goal-survival-'+(port===2?'p2-':'')+chosen.address;
 const registry=Evidence.createRegistry({romHash:cfg.romHash,coreRevision:cfg.coreRevision,
  profileRevision:cfg.profileRevision,detectorRevision:cfg.detectorRevision});
 registry.register({id:goalId+'-discovery',goalId,group:'DISCOVERY',parentStateHash:startHash,
  /* a TERMINAL candidate that some run ended above its floor is contradicted;
     a PER_LOSS candidate already passed "explained at least twice as many
     losses as it missed" - an unexplained long gap is a cut-scene as often as
     a death - so its discovery record is a confirmation */
  restorePath:['start'],outcome:chosen.kind==='TERMINAL'&&chosen.contradicted?'contradicted':'confirmed',
  episodeOrigin:'survival-discovery'});
 const verdicts=[];
 const verifyRuns={};
 for(const [group,leadFrames,seedBase] of [['CALIBRATION',cfg.calibrationLead,101],['HOLDOUT',cfg.holdoutLead,202]]){
  const led=lead(driver,start,spec,seedBase,leadFrames,meter,port);
  driver.restore(led.snapshot);
  const parent=driver.stateHash();
  if(!led.probe){note('verify',{partition:group,skipped:'no lead-in state from this seed is in play'});
   verdicts.push({group,outcome:'inconclusive'});continue;}
  const vcontrol=controlTester(driver,led.probe,cfg);
  const vr=[];
  for(let k=0;k<cfg.verifyPolicies;k++){
   if(meter.frames>cfg.frameBudget)break;
   const pol=k===0?()=>0:randomPolicy(spec,seedBase+k);
   vr.push(rollout(driver,led.snapshot,pol,vcontrol,cfg,meter));
  }
  verifyRuns[group]=vr;
  const v=verdictFor(vr,chosen,cfg);
  verdicts.push({group,...v});
  note('verify',{partition:group,leadFrames:led.frames,outcome:v.outcome,losses:v.losses,linked:v.linked,
   lossEvents:vr.reduce((n,r)=>n+r.losses.length,0),explained:v.explained,
   terminals:vr.filter(r=>r.terminal!==null).length,contradictions:v.contradictions.slice(0,2)});
  registry.register({id:goalId+'-'+group.toLowerCase(),goalId,group,parentStateHash:parent,
   restorePath:['start','lead-'+seedBase+'x'+led.frames],outcome:v.outcome,episodeOrigin:'survival-'+group.toLowerCase()});
  if(v.outcome==='contradicted')registry.contradict(goalId,v.contradictions[0]);
 }
 const polarityEvidenced=verdicts.every(v=>v.outcome==='confirmed');
 const promotion=registry.promote(goalId,{polarity:'NEGATIVE',polarityEvidenced,
  profileRevision:cfg.profileRevision,nowMs:cfg.nowMs});
 note('promote',{verified:promotion.verified,lifecycle:promotion.lifecycle,blockers:promotion.blockers||[]});
 /* progress: kept only if no calibration or holdout run saw it fall in play */
 const proposed=progressFieldsFrom(found.progress.filter(p=>p.address!==chosen.address),cfg.maxProgressFields*3,runs[0].width);
 const checkRuns=[...(verifyRuns.CALIBRATION||[]),...(verifyRuns.HOLDOUT||[])];
 const progressFields=proposed.filter(f=>progressHolds(checkRuns,f)).slice(0,cfg.maxProgressFields);
 note('progress',{proposed:proposed.length,kept:progressFields.length,
  dropped:proposed.length-Math.min(proposed.length,progressFields.length)});
 discovered.progressFields=progressFields;
 discovered.port=port;
 discovered.resource={address:chosen.address,width:1,direction:'decreasing',kind:chosen.kind,port,signed:chosen.signed,floor:chosen.floor,initial:chosen.initial};
 const cost={frames:meter.frames,wallMs:Date.now()-t0};
 note('cost',cost);
 if(!promotion.verified)
  return frozen({schemaVersion:1,pipelineRevision:SURVIVAL_REVISION,status:'REFUSED',stage:'promote',
   reason:'the registry refused to verify the survival goal: '+(promotion.blockers||[]).join('; '),
   goal:null,actions:null,discovered:frozen(discovered),verdicts,cost,trace,
   refusals:[{stage:'promote',blockers:promotion.blockers||[]}]});
 const goal=frozen({id:goalId,lifecycle:promotion.lifecycle,polarity:promotion.polarity,
  evidenceRefs:promotion.evidenceRefs});
 const resource=frozen({address:chosen.address,width:1,endian:'n/a',encoding:'binary',
  encodingDetermined:true,signed:chosen.signed===true,mask:null,direction:'decreasing',step:-1});
 return frozen({schemaVersion:1,pipelineRevision:SURVIVAL_REVISION,status:'VERIFIED',stage:'complete',reason:null,
  goal,resource,discovered:frozen(discovered),
  judgement:frozen({kind:chosen.kind==='TERMINAL'?'TERMINAL_RESOURCE_DEPLETION':'LOSS_OF_LIFE_COUNTER',basis:'survival',
   linkedRuns:chosen.linked,terminalRuns:chosen.terminalRuns,policyDependentTiming:chosen.policyDependentTiming}),
  depletionFact:frozen({floor:chosen.floor,initial:chosen.initial}),
  /* the cost is not one button: it is the game, modulated by every input */
  actions:frozen({neutral:0,effect:null,cost:null,modulatedBy:'policy'}),
  verdicts,cost,
  readResource:memory=>chosen.signed&&memory[chosen.address]>127?memory[chosen.address]-256:memory[chosen.address],
  broker:Reward.createBroker({profileRevision:cfg.profileRevision,contextKey:cfg.contextKey}),
  registry,trace,refusals:[]});
}

const api=Object.freeze({SURVIVAL_REVISION,DEFAULTS,discover,randomPolicy,rollout,controlTester});
root.FlyAgodSurvival=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
