/* Experimental AGOD temporal causal discovery (G5.2).

   WHAT THIS ADDS. agod-causal.js answers "does holding this one button change
   this byte", which is a question about one action and one window. A great deal
   of game structure is not reachable that way: a cost gated behind a latch
   another button sets, a consequence that lands twenty frames later, a resource
   only reachable once another is empty. For those the honest answer from a
   single-action probe is a refusal, and that refusal is what this module is for.

   WHAT IT IS NOT. It is not a correlation engine. Every confirmed dependency
   comes with CONTROL EXPERIMENTS that were actually run, and a dependency is
   rejected unless the controls fail to explain it:

     neutral      the same total number of frames with no input at all, from the
                  same start. Excludes anything time-driven, and this is the
                  control that a phase shift cannot defeat because it has the
                  same length and the same cadence.
     lastAlone    the final action on its own, from the same start. THIS IS THE
                  CONTROL THAT STOPS CAUSALITY BEING ATTRIBUTED TO THE LAST
                  ACTION. If the last action alone does it, the sequence added
                  nothing and there is no multi-step dependency to claim.
     prefixAlone  the sequence without its final action. If the prefix alone
                  does it, the final action is not part of the cause.
     reordered    the same actions in the opposite order. If order does not
                  matter it is a set of actions, not a sequence, and it is
                  reported as such rather than as a temporal dependency.

   DELAY IS MEASURED, NOT ASSUMED. RAM is sampled at several horizons after the
   last action, and each address records the FIRST horizon at which it moved. A
   consequence that lands later than the probe window is exactly what a
   single-frame search misses, so the horizon at which it appeared is part of
   the evidence.

   REPRODUCIBILITY IS REQUIRED. A dependency seen once from one start is a
   candidate. It is confirmed only when it reproduces from independent starts,
   and the number that agreed is reported rather than averaged away.

   PRUNING IS BY STATE IDENTITY, NEVER BY "NOTHING VISIBLE HAPPENED". Two
   prefixes that leave the machine in the same observed state are equivalent and
   the second is skipped. A prefix that changed no byte we can see is NOT
   skipped: arming a latch that lives in a register, or in memory outside the
   window, looks exactly like nothing happening, and that is precisely the case
   this module exists to catch.

   BUDGET IS DECLARED AND ENFORCED. Frames, restores, experiments and wall clock
   are all capped, every cap is reported, and exhaustion is a named outcome
   rather than a silent truncation.

   Platform-independent: it uses restore / run / readRam / snapshot / stateHash
   and the driver's own action specification, nothing else. */
(function(root){'use strict';
const SCHEMA_VERSION=1,SEQUENCES_REVISION='agod-sequences-d1-2';

const DEFAULTS=Object.freeze({
 /* one press: hold, then release, so an edge-triggered cartridge sees an edge */
 hold:4,release:8,
 /* where RAM is sampled after the last action. 0 is "immediately", and the
    later ones are what catch a delayed consequence. */
 horizons:Object.freeze([0,10,30,60]),
 /* search shape */
 maxDepth:2,
 starts:3,
 /* how many independent starts must agree before a dependency is confirmed */
 agreementRequired:2,
 /* budget */
 frameBudget:400000,
 experimentBudget:1200,
 restoreBudget:4000,
 wallMsBudget:900000,
 /* depth-3 is not exhaustive: only pairs whose effect the controls did not
    explain are extended, and only this many of them */
 depth3Extensions:6,
 /* an address that moves in the neutral control at any horizon is time-driven
    for the purposes of this search and is excluded from every claim */
 excludeNeutralMovers:true});

const frozen=Object.freeze.bind(Object);

/* ---- primitives ----
   A step is data, so a sequence can be serialised, replayed and compared. */
const PRESS=(mask,hold,release)=>({kind:'PRESS',mask,hold,release});
const HOLD=(mask,frames)=>({kind:'HOLD',mask,frames});
const WAIT=frames=>({kind:'WAIT',frames});

function describeStep(step){
 if(step.kind==='PRESS')return 'PRESS('+step.mask+')';
 if(step.kind==='HOLD')return 'HOLD('+step.mask+','+step.frames+')';
 if(step.kind==='WAIT')return 'WAIT('+step.frames+')';
 return step.kind;
}
const describe=steps=>steps.map(describeStep).join(' -> ');
const keyOf=steps=>steps.map(describeStep).join('|');

function framesOf(step){
 if(step.kind==='PRESS')return step.hold+step.release;
 if(step.kind==='HOLD')return step.frames;
 if(step.kind==='WAIT')return step.frames;
 return 0;
}
const totalFrames=steps=>steps.reduce((sum,step)=>sum+framesOf(step),0);

function diff(before,after,width){
 const moved=[];
 const length=Math.min(before.length,after.length,width);
 for(let address=0;address<length;address++)
  if(before[address]!==after[address])
   moved.push({address,from:before[address],to:after[address],
    delta:after[address]-before[address]});
 return moved;
}

function run(driver,steps){
 for(const step of steps){
  if(step.kind==='PRESS'){driver.run(step.mask,step.hold);driver.run(0,step.release);}
  else if(step.kind==='HOLD')driver.run(step.mask,step.frames);
  else if(step.kind==='WAIT')driver.run(0,step.frames);
 }
}

/* ---- a savestate as comparable numbers ----
   Used ONLY to rank and group prefixes, never as evidence for a claim. A
   dependency is still confirmed on the observed RAM window with controls; the
   savestate just says "this prefix left the machine somewhere the others did
   not", which is the cheap signal that makes a hidden intermediate step worth
   the expensive experiment. Frame and audio buffers are skipped: they are
   derived output and would swamp the comparison. */
function decodeBase64Bytes(text){
 if(typeof Buffer!=='undefined')return Buffer.from(text,'base64');
 const raw=root.atob(text),out=new Uint8Array(raw.length);
 for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
 return out;
}
function flattenState(snapshot){
 let value=snapshot;
 if(typeof value==='string'){try{value=JSON.parse(value);}catch(error){return null;}}
 const leaves=[];
 const walk=(node,path,depth)=>{
  if(node===null||node===undefined||depth>6)return;
  if(typeof node==='number'||typeof node==='boolean'){leaves.push({path,data:[Number(node)]});return;}
  if(typeof node==='string'){
   if(node.length>=64&&/^[A-Za-z0-9+/=]+$/.test(node)){
    try{leaves.push({path,data:decodeBase64Bytes(node)});}catch(error){}
   }
   return;
  }
  if(ArrayBuffer.isView(node)){leaves.push({path,data:node});return;}
  if(Array.isArray(node)){
   if(node.length&&typeof node[0]==='number'){leaves.push({path,data:node});return;}
   for(let i=0;i<node.length&&i<64;i++)walk(node[i],path+'['+i+']',depth+1);
   return;
  }
  if(typeof node==='object')
   for(const key of Object.keys(node)){
    if(/video|pixel|audio|sample/i.test(key))continue;
    walk(node[key],path?path+'.'+key:key,depth+1);
   }
 };
 walk(value,'',0);
 return leaves;
}
/* positions at which two flattened states differ, as "path:index" -> value in b */
function stateDiff(a,b,into){
 if(!a||!b)return into;
 const byPath=new Map(a.map(leaf=>[leaf.path,leaf.data]));
 for(const leaf of b){
  const other=byPath.get(leaf.path);
  if(!other)continue;
  const n=Math.min(other.length,leaf.data.length);
  for(let i=0;i<n;i++)if(other[i]!==leaf.data[i])into.set(leaf.path+':'+i,leaf.data[i]);
 }
 return into;
}

/* ---- the bench: everything an experiment needs, built once ----
   Shared by discover() and frontier() so both searches meter the same budget,
   draw the same independent starts and sample the same horizons. */
function bench(driver,config){
 const started=Date.now();
 if(!driver||['restore','run','readRam','snapshot','stateHash']
  .some(key=>typeof driver[key]!=='function'))
  return {refused:'driver must provide restore, run, readRam, snapshot '
    +'and stateHash'};

 /* THE ACTION SET COMES FROM THE PLATFORM, as in agod-pipeline.js: this module
    must not carry a console's pad layout either. */
 const spec=driver.actionSpec||null;
 let masks;
 if(Array.isArray(config.masks))masks=config.masks.slice();
 else if(spec&&Array.isArray(spec.singleButtonMasks)&&spec.singleButtonMasks.length)
  masks=spec.singleButtonMasks.slice();
 else return {refused:'no action set: the driver declares no action '
   +'specification and the caller supplied none'};
 if(spec&&typeof spec.maskAllowed==='function')
  for(const mask of masks){
   const verdict=spec.maskAllowed(mask);
   if(verdict&&verdict.allowed===false)
    return {refused:'action mask '+mask+' is not one this platform can '
      +'produce: '+verdict.reason};
  }

 let width;
 try{width=driver.readRam().length;}
 catch(error){return {refused:'the driver could not be read: '
   +(error&&error.message||error)};}

 /* ---- budget ---- */
 const budget={frames:0,restores:0,experiments:0,
  frameBudget:config.frameBudget,experimentBudget:config.experimentBudget,
  restoreBudget:config.restoreBudget,wallMsBudget:config.wallMsBudget,
  exhausted:null};
 const metered={
  restore(state){budget.restores++;driver.restore(state);},
  run(mask,frames){budget.frames+=frames;driver.run(mask,frames);},
  readRam(){return driver.readRam();},
  snapshot(){return driver.snapshot();},
  stateHash(){return driver.stateHash();}};
 const exhausted=()=>{
  if(budget.exhausted)return budget.exhausted;
  if(budget.frames>config.frameBudget)budget.exhausted='FRAMES';
  else if(budget.experiments>config.experimentBudget)budget.exhausted='EXPERIMENTS';
  else if(budget.restores>config.restoreBudget)budget.exhausted='RESTORES';
  else if(Date.now()-started>config.wallMsBudget)budget.exhausted='WALL_CLOCK';
  return budget.exhausted;
 };

 const pristine=driver.snapshot();
 /* Independent starts, each a different number of idle frames from the same
    boot, so a dependency has to hold from more than one machine state. */
 const starts=[];
 for(let i=0;i<config.starts;i++){
  metered.restore(pristine);
  metered.run(0,13+i*17);
  starts.push({id:'start-'+i,snapshot:metered.snapshot(),
   stateHash:metered.stateHash()});
 }
 const independentStarts=new Set(starts.map(s=>s.stateHash)).size;

 /* ---- one experiment: run a sequence from a start and sample the horizons ----
    Returns, per address, the FIRST horizon at which it differed from the
    pre-sequence reading. */
 function observe(start,steps){
  budget.experiments++;
  metered.restore(start.snapshot);
  const before=metered.readRam();
  run(metered,steps);
  const firstMoved=new Map();
  let previousHorizon=0,last=before,stateAtZero=null;
  const horizons=(arguments.length>2&&arguments[2]&&arguments[2].horizons)||config.horizons;
  const wantState=arguments.length>2&&arguments[2]&&arguments[2].captureState;
  for(const horizon of horizons){
   if(horizon>previousHorizon){metered.run(0,horizon-previousHorizon);previousHorizon=horizon;}
   const now=metered.readRam();
   if(wantState&&stateAtZero===null)stateAtZero=flattenState(metered.snapshot());
   for(const entry of diff(before,now,width))
    if(!firstMoved.has(entry.address))
     firstMoved.set(entry.address,{...entry,horizon});
   last=now;
  }
  /* what each moved byte reads at the END of the window: a byte that moved and
     came back is a transient, and only this tells the two apart */
  for(const [address,entry] of firstMoved)
   entry.finalDelta=last[address]-before[address];
  return {firstMoved,endHash:metered.stateHash(),state:stateAtZero};
 }

 /* the neutral control: the same total length, no input, same start */
 const neutralCache=new Map();
 function neutral(start,frames){
  const key=start.id+':'+frames;
  if(neutralCache.has(key))return neutralCache.get(key);
  const observed=observe(start,[WAIT(frames)]);
  neutralCache.set(key,observed);
  return observed;
 }


 /* FULL machine-state identity, from the savestate rather than from the RAM
    window. Two prefixes may leave every OBSERVED byte equal and still differ in
    a register, in cartridge RAM or anywhere else outside the window - which is
    exactly a hidden intermediate state. Equality of the whole savestate is the
    only sound reason to call two prefixes equivalent; equality of the window is
    not, and treating it as one would prune the hidden step this search is for.
    Null when a snapshot cannot be serialised, and then nothing is deduplicated. */
 function fullStateKey(){
  try{
   const snapshot=metered.snapshot();
   const text=typeof snapshot==='string'?snapshot:JSON.stringify(snapshot);
   let h1=0x811c9dc5,h2=0x1b873593;
   for(let i=0;i<text.length;i++){
    const c=text.charCodeAt(i);
    h1=Math.imul(h1^c,0x01000193)>>>0;
    h2=Math.imul(h2^(c+i),0x85ebca6b)>>>0;
   }
   return h1.toString(16).padStart(8,'0')+h2.toString(16).padStart(8,'0')+':'+text.length;
  }catch(error){return null;}
 }
 return {masks,width,budget,metered,exhausted,pristine,starts,independentStarts,
  observe,neutral,fullStateKey,started,spec};
}

function discover(driver,options){
 const config={...DEFAULTS,...(options||{})};
 const built=bench(driver,config);
 if(built.refused)
  return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
   status:'REFUSED',reason:built.refused,confirmed:[],rejected:[],budget:null});
 const {masks,width,budget,metered,exhausted,starts,independentStarts,observe,
  neutral,started}=built;

 const confirmed=[],rejected=[],notes=[];
 /* every candidate's outcome is counted, so "nothing was confirmed" can be
    read apart from "nothing was tried" */
 const outcomes={};
 const count=verdict=>{outcomes[verdict]=(outcomes[verdict]||0)+1;};
 const seenTrajectory=new Set();
 /* state identity after a prefix, so equivalent prefixes are not re-explored */
 const prefixState=new Map();

 function pressSteps(mask){return PRESS(mask,config.hold,config.release);}

 /* ---- evaluate one candidate sequence ---- */
 function evaluate(steps){
  const key=keyOf(steps);
  if(seenTrajectory.has(key))return null;
  seenTrajectory.add(key);
  if(exhausted())return null;

  const span=totalFrames(steps);
  const start=starts[0];
  const main=observe(start,steps);
  if(!main.firstMoved.size){
   count('NO_EFFECT');
   return {steps,described:describe(steps),verdict:'NO_EFFECT',
    reason:'the sequence changed no observed byte at any horizon'};
  }

  /* exclude everything the neutral run of the same length also moved */
  const control=neutral(start,span);
  const candidates=[];
  for(const [address,entry] of main.firstMoved){
   if(config.excludeNeutralMovers&&control.firstMoved.has(address))continue;
   candidates.push(entry);
  }
  if(!candidates.length){
   count('TIME_DRIVEN');
   return {steps,described:describe(steps),verdict:'TIME_DRIVEN',
    reason:'every byte the sequence moved also moved in a neutral run of the '
     +'same length, so nothing here is action-driven'};
  }

  /* THE CONTROL THAT MATTERS: the last action on its own.
     NOT FOR A ONE-STEP SEQUENCE. There the "last action alone" IS the sequence,
     so the control reproduces the effect by construction and every single
     action came back EXPLAINED_BY_PART - which made the depth-1 line read as
     "no single action does anything" on a cartridge where single actions do
     plenty. A degenerate control is worse than no control, because it looks
     like evidence. At depth 1 the neutral run is the only control there is,
     and that is exactly the question agod-causal.js already asks. */
  const last=steps[steps.length-1];
  const prefix=steps.slice(0,-1);
  const multiStep=steps.length>1;
  const lastAlone=multiStep?observe(start,[last]):null;
  const prefixAlone=prefix.length?observe(start,prefix):null;
  const reorderable=steps.length===2&&steps.every(s=>s.kind==='PRESS');
  const reordered=reorderable?observe(start,[steps[1],steps[0]]):null;

  const attributed=[],explained=[];
  for(const entry of candidates){
   const byLast=lastAlone?lastAlone.firstMoved.get(entry.address):null;
   if(byLast&&Math.sign(byLast.delta)===Math.sign(entry.delta)){
    explained.push({address:entry.address,by:'lastAlone',
     delta:entry.delta,controlDelta:byLast.delta});
    continue;
   }
   const byPrefix=prefixAlone?prefixAlone.firstMoved.get(entry.address):null;
   if(byPrefix&&Math.sign(byPrefix.delta)===Math.sign(entry.delta)){
    explained.push({address:entry.address,by:'prefixAlone',
     delta:entry.delta,controlDelta:byPrefix.delta});
    continue;
   }
   attributed.push(entry);
  }
  if(!attributed.length){
   count('EXPLAINED_BY_PART');
   return {steps,described:describe(steps),verdict:'EXPLAINED_BY_PART',
    reason:'every effect was reproduced by the last action alone or by the '
     +'prefix alone, so the sequence adds nothing',explained};
  }

  /* order sensitivity, reported rather than assumed */
  let orderSensitive=null;
  if(reordered){
   orderSensitive=attributed.some(entry=>{
    const swapped=reordered.firstMoved.get(entry.address);
    return !(swapped&&Math.sign(swapped.delta)===Math.sign(entry.delta));
   });
  }

  /* ---- reproducibility from independent starts ---- */
  const agreeing=[start.id];
  const perStart={[start.id]:attributed.map(e=>({address:e.address,delta:e.delta,
   horizon:e.horizon}))};
  for(let i=1;i<starts.length;i++){
   if(exhausted())break;
   const other=starts[i];
   const repeat=observe(other,steps);
   const otherControl=neutral(other,span);
   const matched=attributed.filter(entry=>{
    if(config.excludeNeutralMovers&&otherControl.firstMoved.has(entry.address))return false;
    const seen=repeat.firstMoved.get(entry.address);
    return !!seen&&Math.sign(seen.delta)===Math.sign(entry.delta);
   });
   perStart[other.id]=matched.map(e=>({address:e.address,
    delta:(repeat.firstMoved.get(e.address)||{}).delta,
    horizon:(repeat.firstMoved.get(e.address)||{}).horizon}));
   if(matched.length===attributed.length&&attributed.length)agreeing.push(other.id);
  }

  const record={steps:steps.map(s=>({...s})),described:describe(steps),
   spanFrames:span,
   attributed:attributed.map(e=>({address:e.address,from:e.from,to:e.to,
    delta:e.delta,firstHorizon:e.horizon})),
   explainedByPart:explained,
   orderSensitive,
   stepCount:steps.length,
   controls:{neutralFrames:span,
    neutralMovedCount:control.firstMoved.size,
    lastAloneMovedCount:lastAlone?lastAlone.firstMoved.size:null,
    lastAloneApplicable:multiStep,
    prefixAloneMovedCount:prefixAlone?prefixAlone.firstMoved.size:null,
    reorderedMovedCount:reordered?reordered.firstMoved.size:null},
   startsAgreeing:agreeing.length,startsTried:starts.length,
   perStart,
   delayed:attributed.filter(e=>e.horizon>0)
    .map(e=>({address:e.address,firstHorizon:e.horizon})),
   /* a replayable recipe: these fields alone are enough to run it again */
   experiment:{startStateHash:start.stateHash,
    steps:steps.map(describeStep),horizons:config.horizons.slice(),
    hold:config.hold,release:config.release}};

  if(agreeing.length>=Math.min(config.agreementRequired,starts.length)){
   record.verdict='CONFIRMED';
   count('CONFIRMED');
   confirmed.push(frozen(record));
  }else{
   count('NOT_REPRODUCED');
   record.verdict='NOT_REPRODUCED';
   record.reason='the effect appeared from '+agreeing.length+' of '
    +starts.length+' independent starts, below the required '
    +config.agreementRequired;
   rejected.push(frozen(record));
  }
  return record;
 }

 /* ---- depth 1: the single-action baseline, run here so the comparison with
         the sequence result is made by the same instrument on the same starts */
 const depth1=[];
 for(const mask of masks){
  if(exhausted())break;
  const outcome=evaluate([pressSteps(mask)]);
  if(outcome)depth1.push({mask,verdict:outcome.verdict,
   attributed:outcome.attributed?outcome.attributed.length:0,
   addresses:outcome.attributed?outcome.attributed.map(e=>e.address):[]});
 }

 /* ---- depth 2: ordered pairs ---- */
 const interesting=[];
 if(config.maxDepth>=2)
  for(const first of masks){
   if(exhausted())break;
   /* prefix state identity: two prefixes leaving the same state are equivalent */
   metered.restore(starts[0].snapshot);
   run(metered,[pressSteps(first)]);
   const stateAfterPrefix=metered.stateHash();
   if(prefixState.has(stateAfterPrefix)){
    notes.push({skipped:'PRESS('+first+')',
     equivalentTo:prefixState.get(stateAfterPrefix),
     why:'the machine is in the same observed state after both prefixes'});
    continue;
   }
   prefixState.set(stateAfterPrefix,'PRESS('+first+')');
   for(const second of masks){
    if(first===second)continue;
    if(exhausted())break;
    const outcome=evaluate([pressSteps(first),pressSteps(second)]);
    if(outcome&&outcome.verdict==='CONFIRMED')interesting.push(outcome);
   }
  }

 /* ---- depth 3, bounded: only extend pairs that were confirmed ---- */
 if(config.maxDepth>=3){
  let extensions=0;
  for(const pair of interesting){
   if(extensions>=config.depth3Extensions||exhausted())break;
   for(const third of masks){
    if(extensions>=config.depth3Extensions||exhausted())break;
    const steps=pair.steps.concat([pressSteps(third)]);
    evaluate(steps);
    extensions++;
   }
  }
 }

 /* ---- WAIT and HOLD variants of what was confirmed, to separate "the
        sequence did it" from "the time between the steps did it" ---- */
 const timing=[];
 /* MULTI-STEP confirmations only. Taking the first few of `confirmed` picked
    up the depth-1 records, which have one step and were skipped, so the pair
    this probe exists to time never reached it and the timing list came back
    empty. */
 for(const record of confirmed.filter(c=>c.stepCount===2).slice(0,4)){
  if(exhausted())break;
  const [a,b]=record.steps;
  const baseAddresses=record.attributed.map(e=>e.address);
  for(const gap of [30,90]){
   if(exhausted())break;
   const withGap=[a,WAIT(gap),b];
   const outcome=evaluate(withGap);
   if(!outcome)continue;
   /* WHICH OF THE ORIGINAL EFFECTS SURVIVED THE GAP. This is how a window is
      measured rather than assumed: if the dependency needs the two actions
      close together, inserting time between them removes the effect, and the
      addresses that stop moving name the condition. Reporting only the verdict
      would hide that, because "explained by a part" is also what a sequence
      with no effect left looks like. */
   const survived=(outcome.attributed||[]).map(e=>e.address)
    .filter(address=>baseAddresses.indexOf(address)>=0);
   const lost=baseAddresses.filter(address=>survived.indexOf(address)<0);
   timing.push({base:record.described,gap,verdict:outcome.verdict,
    attributed:outcome.attributed?outcome.attributed.length:0,
    baseAddresses:baseAddresses.slice(),survivedAddresses:survived,
    lostAddresses:lost,
    reading:lost.length&&!survived.length
     ?'the dependency needs the steps within '+gap+' frames of each other: '
      +'every attributed address stopped moving when that much time was inserted'
     :(lost.length?'partly time-sensitive: '+lost.length+' of '
       +baseAddresses.length+' attributed addresses stopped moving'
      :'insensitive to a '+gap+'-frame gap')});
  }
 }

 return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
  status:confirmed.length?'CONFIRMED':'NO_DEPENDENCY_CONFIRMED',
  observedRamBytes:width,
  actions:masks.slice(),
  actionSource:Array.isArray(config.masks)?'caller':'driver',
  starts:starts.map(s=>({id:s.id,stateHash:s.stateHash})),
  independentStarts,
  horizons:config.horizons.slice(),
  /* the single-action baseline, measured by THIS instrument on THESE starts,
     so "the one-action search finds nothing here" is a measurement from the
     same bench rather than a comparison across two different ones */
  depth1,
  singleActionAttributedTotal:depth1.reduce((sum,d)=>sum+d.attributed,0),
  /* the union of every address a SINGLE action was shown to move. A resource
     that is absent from this set and present in a multi-step confirmation is
     the whole point of this module, and stating the set lets that be asserted
     instead of read off a log. */
  singleActionAddresses:[...new Set(depth1.reduce((all,d)=>all.concat(d.addresses),[]))]
   .sort((a,b)=>a-b),
  multiStepConfirmed:confirmed.filter(c=>c.stepCount>1).length,
  outcomes,
  confirmed,rejected,
  /* how the latch window was probed: the same pair with time inserted */
  timing,
  notes,
  budget:frozen({...budget,wallMs:Date.now()-started,
   framesSpent:budget.frames}),
  /* said plainly, because a bounded search that ran out is not a search that
     found nothing */
  completeness:budget.exhausted
   ?'INCOMPLETE: the budget was exhausted ('+budget.exhausted+'), so an absent '
    +'dependency here is not evidence of absence'
   :'the declared search space was covered within budget'});
}

/* ==== D1: a budgeted frontier search to depth 3 and beyond ====

   WHY discover() IS NOT ENOUGH. It reaches depth 3 only by extending pairs it
   has already CONFIRMED. A chain whose intermediate state is invisible has no
   confirmable pair at all: A then B changes nothing the window shows that the
   parts do not also change, so the pair is rejected and the third step is never
   tried. Requiring a confirmed prefix assumes every step leaves a visible mark.

   WHAT THIS DOES INSTEAD. It keeps a FRONTIER of prefixes and decides which to
   extend by information value, not by confirmation:

     1. every prefix on the frontier is extended by every action - one cheap
        run each, sampling the window over the horizons and taking the savestate;
     2. each result is reduced to a SIGNATURE: the places its savestate differs
        from a neutral run of the same length, minus the places that differ
        between neutral runs of slightly different lengths (those are clocks);
     3. results with the same signature are one class and are extended once;
     4. classes are ranked by how RARE their signature is at this depth and how
        much of it has not been seen at a shallower depth, and only the best
        `beamWidth` are extended. A hidden stage reaching a value nothing else
        reached is exactly a rare, novel signature.

   The savestate is used ONLY for steps 2-4. No dependency is claimed from it:
   a claim needs an effect in the observed window that survives every control.

   THE CONTROLS FOR n STEPS. neutral; then EVERY sequence obtained by deleting
   one step (for three steps: the last alone is covered by deleting twice, so
   the single steps are run too) - if any shorter sequence reproduces the effect
   the longer one is not its cause; then adjacent transpositions, for order;
   then independent starts. At depth 1 only neutral applies.

   A BOUNDED SEARCH SAYS WHEN IT STOPPED. Classes dropped by the beam are
   counted, and with any dropped class or a spent budget the result is
   INCOMPLETE: absence of a dependency is then not evidence of absence. */
const FRONTIER_DEFAULTS=Object.freeze({
 maxDepth:3,beamWidth:4,
 /* neutral runs at these offsets from the prefix length define "clock" state */
 volatileOffsets:Object.freeze([1,2,5]),
 /* a delayed effect is narrowed until its interval is at most this wide */
 delayResolution:2,
 /* how many times a spending sequence is repeated to find a floor */
 depletionRepeats:8});

function frontier(driver,options){
 const config={...DEFAULTS,...FRONTIER_DEFAULTS,...(options||{})};
 const built=bench(driver,config);
 if(built.refused)
  return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
   mode:'frontier',status:'REFUSED',reason:built.refused,confirmed:[],budget:null});
 const {masks,width,budget,metered,exhausted,starts,independentStarts,observe,
  neutral,started}=built;
 const press=mask=>PRESS(mask,config.hold,config.release);
 const root=starts[0];
 let heapPeak=0;
 const heap=()=>{
  try{const used=typeof process!=='undefined'&&process.memoryUsage
   ?process.memoryUsage().heapUsed:0;if(used>heapPeak)heapPeak=used;}catch(error){}
 };

 /* one cached, metered run per (start, sequence) */
 const cache=new Map();
 function probe(start,steps,withState){
  const key=start.id+'#'+keyOf(steps)+(withState?'#s':'');
  if(cache.has(key))return cache.get(key);
  const plain=cache.get(start.id+'#'+keyOf(steps)+'#s');
  if(plain&&!withState)return plain;
  const result=observe(start,steps,{captureState:!!withState});
  cache.set(key,result);heap();
  return result;
 }

 /* clock positions for a prefix length: differ between neutral runs alone */
 const volatileByLength=new Map(),neutralStateByLength=new Map();
 function neutralState(length){
  if(neutralStateByLength.has(length))return neutralStateByLength.get(length);
  const state=probe(root,[WAIT(length)],true).state;
  neutralStateByLength.set(length,state);
  return state;
 }
 function volatile(length){
  if(volatileByLength.has(length))return volatileByLength.get(length);
  const base=neutralState(length),set=new Map();
  for(const offset of config.volatileOffsets)
   stateDiff(base,neutralState(length+offset),set);
  const keys=new Set(set.keys());
  volatileByLength.set(length,keys);
  return keys;
 }
 function signature(steps,state){
  const length=totalFrames(steps);
  const clocks=volatile(length),pairs=new Map();
  stateDiff(neutralState(length),state,pairs);
  const kept=[];
  for(const [position,value] of pairs)if(!clocks.has(position))kept.push(position+'='+value);
  kept.sort();
  return kept;
 }

 /* the effects of a sequence in the observed window, net of the neutral run */
 function visible(start,steps){
  const main=probe(start,steps,start===root);
  const control=neutral(start,totalFrames(steps));
  const out=[];
  for(const [address,entry] of main.firstMoved)
   if(!control.firstMoved.has(address))out.push(entry);
  return out;
 }
 const sameSign=(a,b)=>!!a&&!!b&&Math.sign(a.delta)===Math.sign(b.delta);
 /* every sequence one step shorter, and the single steps */
 function reductions(steps){
  const out=new Map();
  for(let i=0;i<steps.length;i++){
   const shorter=steps.slice(0,i).concat(steps.slice(i+1));
   if(shorter.length)out.set(keyOf(shorter),shorter);
  }
  if(steps.length>2)for(const step of steps)out.set(keyOf([step]),[step]);
  return [...out.values()];
 }

 const confirmed=[],rejected=[],outcomes={};
 const count=verdict=>{outcomes[verdict]=(outcomes[verdict]||0)+1;};
 const judged=new Set();

 function judge(steps){
  const key=keyOf(steps);
  if(judged.has(key)||exhausted())return null;
  judged.add(key);
  const effects=visible(root,steps);
  if(!effects.length){count('NO_VISIBLE_EFFECT');return null;}
  /* necessity of every step: an effect a shorter sequence also produces is
     not this sequence's */
  const explained=[];let attributed=effects.slice();
  for(const shorter of reductions(steps)){
   if(exhausted())break;
   const part=new Map(visible(root,shorter).map(e=>[e.address,e]));
   attributed=attributed.filter(entry=>{
    if(sameSign(part.get(entry.address),entry)){
     explained.push({address:entry.address,by:describe(shorter)});return false;}
    return true;
   });
   if(!attributed.length)break;
  }
  if(!attributed.length){count('EXPLAINED_BY_PART');return null;}

  /* order: adjacent transpositions */
  let orderSensitive=null;
  if(steps.length>1){
   orderSensitive=true;
   for(let i=0;i+1<steps.length&&!exhausted();i++){
    const swapped=steps.slice();
    [swapped[i],swapped[i+1]]=[swapped[i+1],swapped[i]];
    if(keyOf(swapped)===key)continue;
    const other=new Map(visible(root,swapped).map(e=>[e.address,e]));
    if(attributed.every(entry=>sameSign(other.get(entry.address),entry)))orderSensitive=false;
   }
  }

  /* independent starts */
  const agreeing=[root.id],perStart={};
  for(let i=1;i<starts.length&&!exhausted();i++){
   const seen=new Map(visible(starts[i],steps).map(e=>[e.address,e]));
   const matched=attributed.filter(entry=>sameSign(seen.get(entry.address),entry));
   perStart[starts[i].id]=matched.length;
   if(matched.length===attributed.length)agreeing.push(starts[i].id);
  }

  const record={steps:steps.map(s=>({...s})),described:describe(steps),
   stepCount:steps.length,spanFrames:totalFrames(steps),
   attributed:attributed.map(e=>({address:e.address,from:e.from,to:e.to,
    delta:e.delta,firstHorizon:e.horizon,finalDelta:e.finalDelta,
    transient:e.finalDelta===0})),
   explainedByPart:explained,orderSensitive,
   controls:{neutral:true,reductions:reductions(steps).map(describe),
    transpositions:steps.length>1},
   startsAgreeing:agreeing.length,startsTried:starts.length,perStart,
   experiment:{startStateHash:root.stateHash,steps:steps.map(describeStep),
    horizons:config.horizons.slice(),hold:config.hold,release:config.release}};
  if(agreeing.length>=Math.min(config.agreementRequired,starts.length)){
   record.verdict='CONFIRMED';count('CONFIRMED');confirmed.push(record);
  }else{
   record.verdict='NOT_REPRODUCED';count('NOT_REPRODUCED');rejected.push(record);
  }
  return record;
 }

 /* ---- the frontier ---- */
 const classes=[];          /* every class ever formed, for the graph */
 const seenPairs=new Set(); /* signature pairs seen at any shallower depth */
 const edges=[];
 let frontierNow=[{id:'n0',depth:0,steps:[],signature:[],members:1}];
 classes.push(frontierNow[0]);
 let expansions=0,droppedClasses=0,nextId=1;
 const perDepth=[];

 for(let depth=1;depth<=config.maxDepth&&!exhausted();depth++){
  const produced=[];
  for(const node of frontierNow){
   for(const mask of masks){
    if(exhausted())break;
    const steps=node.steps.concat([press(mask)]);
    const result=probe(root,steps,true);
    expansions++;
    produced.push({from:node.id,mask,steps,sig:signature(steps,result.state)});
    /* the flattened savestate is tens of thousands of numbers; once it has
       been reduced to a signature it is dropped, or the cache alone holds
       hundreds of megabytes - measured at 430 MB before this line */
    result.state=null;
    judge(steps);
   }
  }
  /* classes at this depth */
  const frequency=new Map();
  for(const item of produced)for(const pair of item.sig)
   frequency.set(pair,(frequency.get(pair)||0)+1);
  const byKey=new Map();
  for(const item of produced){
   const key=item.sig.join(',');
   let entry=byKey.get(key);
   if(!entry){
    let value=0,novel=0;
    for(const pair of item.sig)if(!seenPairs.has(pair)){novel++;value+=1/frequency.get(pair);}
    entry={id:'n'+(nextId++),depth,steps:item.steps,signature:item.sig,
     members:0,novelPairs:novel,value};
    byKey.set(key,entry);classes.push(entry);
   }
   entry.members++;
   edges.push({from:item.from,to:entry.id,mask:item.mask,depth});
  }
  const ranked=[...byKey.values()].sort((a,b)=>b.value-a.value||a.id.localeCompare(b.id));
  const kept=depth<config.maxDepth?ranked.slice(0,config.beamWidth):[];
  if(depth<config.maxDepth)droppedClasses+=Math.max(0,ranked.length-kept.length);
  for(const entry of ranked)entry.extended=kept.indexOf(entry)>=0;
  for(const item of produced)for(const pair of item.sig)seenPairs.add(pair);
  perDepth.push({depth,expanded:produced.length,classes:ranked.length,kept:kept.length});
  frontierNow=kept;
 }

 /* ---- measure each confirmed dependency further ---- */
 for(const record of confirmed){
  if(exhausted())break;
  /* the window: time inserted at each joint */
  record.windows=[];
  if(record.stepCount>1)
   for(let joint=1;joint<record.steps.length&&!exhausted();joint++){
    const lost=[];
    for(const gap of [20,60,120]){
     const withGap=record.steps.slice(0,joint).concat([WAIT(gap)],record.steps.slice(joint));
     const seen=new Map(visible(root,withGap).map(e=>[e.address,e]));
     const survives=record.attributed.filter(e=>!e.transient)
      .every(e=>sameSign(seen.get(e.address),e));
     lost.push({gap,survives});
    }
    const firstLost=lost.find(x=>!x.survives),lastKept=[...lost].reverse().find(x=>x.survives);
    record.windows.push({afterStep:joint,probes:lost,
     /* an interval, because only these gaps were tried */
     windowFrames:firstLost?{moreThan:lastKept?lastKept.gap:0,atMost:firstLost.gap}:null,
     reading:firstLost?'step '+(joint+1)+' must follow within ('
      +(lastKept?lastKept.gap:0)+', '+firstLost.gap+'] frames'
      :'no window found up to 120 frames'});
   }
  /* the delay: narrow (previous horizon, first horizon] by bisection */
  for(const effect of record.attributed){
   if(effect.firstHorizon===0||exhausted())continue;
   const grid=config.horizons;
   let low=grid[grid.indexOf(effect.firstHorizon)-1],high=effect.firstHorizon;
   while(high-low>config.delayResolution&&!exhausted()){
    const mid=Math.floor((low+high)/2);
    budget.experiments++;
    metered.restore(root.snapshot);
    const before=metered.readRam();
    run(metered,record.steps);
    metered.run(0,mid);
    if(metered.readRam()[effect.address]!==before[effect.address])high=mid;else low=mid;
   }
   /* reported as the interval that was measured, never as a single frame */
   effect.delayInterval={moreThan:low,atMost:high};
  }
 }

 /* ---- resources: what a confirmed effect IS, from how it behaves ---- */
 const singleMovers=new Map();   /* address -> set of single-action masks */
 for(const record of confirmed)if(record.stepCount===1)
  for(const effect of record.attributed){
   if(!singleMovers.has(effect.address))singleMovers.set(effect.address,new Map());
   singleMovers.get(effect.address).set(record.steps[0].mask,Math.sign(effect.delta));
  }
 const timeDriven=new Set(neutral(root,totalFrames([press(masks[0])])).firstMoved.keys());
 const fields=new Map();
 for(const record of confirmed)for(const effect of record.attributed){
  if(!fields.has(effect.address))fields.set(effect.address,{address:effect.address,movers:[]});
  fields.get(effect.address).movers.push({described:record.described,
   stepCount:record.stepCount,delta:effect.delta,transient:effect.transient,
   firstHorizon:effect.firstHorizon,delayInterval:effect.delayInterval||null});
 }
 const resources=[];
 for(const field of fields.values()){
  const singles=singleMovers.get(field.address);
  const echoed=singles&&singles.size>=Math.max(3,masks.length-2)
   &&new Set(singles.values()).size===1;
  const persistent=field.movers.filter(m=>!m.transient);
  let role,why;
  if(echoed){role='INPUT_ECHO';
   why='moved the same way by '+singles.size+' of '+masks.length
    +' single actions: it follows input, whatever the input is';}
  else if(!persistent.length){role='TRANSIENT';
   why='every observed change had reverted by the last horizon';}
  else if(persistent.every(m=>m.delta<0)){role='RESOURCE_CANDIDATE';
   why='specific sequences lower it and it stays lowered';}
  else if(persistent.every(m=>m.delta>0)){role='ACCUMULATOR_CANDIDATE';
   why='specific sequences raise it and it stays raised; whether a higher value '
    +'is BETTER is not established by that';}
  else{role='MIXED';why='moved both ways by different sequences';}
  const entry={address:field.address,role,why,movers:field.movers};
  /* a resource candidate is characterised: does it have a floor, and does any
     single action restore it from there? */
  if(role==='RESOURCE_CANDIDATE'&&!exhausted()){
   const spend=confirmed.find(r=>r.attributed.some(e=>e.address===field.address
    &&e.delta<0&&!e.transient));
   budget.experiments++;
   metered.restore(root.snapshot);
   const track=[metered.readRam()[field.address]];
   for(let i=0;i<config.depletionRepeats;i++){
    run(metered,spend.steps);metered.run(0,config.release);
    track.push(metered.readRam()[field.address]);
   }
   const floor=track[track.length-1];
   const reachedFloor=track.length>2&&track[track.length-2]===floor
    &&track[track.length-3]===floor&&floor<track[0];
   entry.depletion={spentBy:spend.described,track,floor:reachedFloor?floor:null,
    reachedFloor};
   if(reachedFloor){
    const depleted=metered.snapshot();
    entry.restoredBy=[];
    for(const mask of masks){
     if(exhausted())break;
     budget.experiments++;
     metered.restore(depleted);
     metered.run(mask,config.hold);metered.run(0,config.release);
     if(metered.readRam()[field.address]>floor)entry.restoredBy.push(mask);
    }
   }
  }
  resources.push(entry);
 }
 resources.sort((a,b)=>a.address-b.address);

 const exhaustive=masks.reduce?Array.from({length:config.maxDepth},
  (_,i)=>Math.pow(masks.length,i+1)).reduce((a,b)=>a+b,0):null;
 const incomplete=budget.exhausted||droppedClasses>0;
 return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
  mode:'frontier',
  status:confirmed.length?'CONFIRMED':'NO_DEPENDENCY_CONFIRMED',
  observedRamBytes:width,actions:masks.slice(),
  starts:starts.map(s=>({id:s.id,stateHash:s.stateHash})),independentStarts,
  horizons:config.horizons.slice(),maxDepth:config.maxDepth,beamWidth:config.beamWidth,
  confirmed,rejected,outcomes,
  multiStepConfirmed:confirmed.filter(c=>c.stepCount>1).length,
  deepestConfirmed:confirmed.reduce((m,c)=>Math.max(m,c.stepCount),0),
  resources,
  timeDrivenAddressCount:timeDriven.size,
  /* the material of the causal state graph: classes are nodes, expansions edges */
  graph:{nodes:classes.map(c=>({id:c.id,depth:c.depth,via:describe(c.steps),
    signatureSize:c.signature.length,novelPairs:c.novelPairs||0,
    value:Number((c.value||0).toFixed(4)),members:c.members,extended:!!c.extended})),
   edges},
  search:{expansions,perDepth,droppedClasses,
   /* what trying everything would have cost, for comparison */
   exhaustiveSequences:exhaustive,
   judgedSequences:judged.size},
  budget:frozen({...budget,framesSpent:budget.frames,wallMs:Date.now()-started,
   heapPeakBytes:heapPeak}),
  completeness:incomplete
   ?'INCOMPLETE: '+(budget.exhausted?'the budget was exhausted ('+budget.exhausted+')'
     :droppedClasses+' state class(es) were not extended by the beam')
    +', so a dependency this search did not find may still exist'
   :'every state class within the declared depth was extended'});
}

const api={SCHEMA_VERSION,SEQUENCES_REVISION,DEFAULTS,FRONTIER_DEFAULTS,discover,frontier,flattenState,
 PRESS,HOLD,WAIT,describe,describeStep,keyOf,totalFrames};
root.FlyAgodSequences=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
