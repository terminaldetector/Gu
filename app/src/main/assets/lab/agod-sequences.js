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
const SCHEMA_VERSION=1,SEQUENCES_REVISION='agod-sequences-g5-1';

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

function discover(driver,options){
 const config={...DEFAULTS,...(options||{})};
 const started=Date.now();
 if(!driver||['restore','run','readRam','snapshot','stateHash']
  .some(key=>typeof driver[key]!=='function'))
  return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
   status:'REFUSED',reason:'driver must provide restore, run, readRam, snapshot '
    +'and stateHash',confirmed:[],rejected:[],budget:null});

 /* THE ACTION SET COMES FROM THE PLATFORM, as in agod-pipeline.js: this module
    must not carry a console's pad layout either. */
 const spec=driver.actionSpec||null;
 let masks;
 if(Array.isArray(config.masks))masks=config.masks.slice();
 else if(spec&&Array.isArray(spec.singleButtonMasks)&&spec.singleButtonMasks.length)
  masks=spec.singleButtonMasks.slice();
 else return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
  status:'REFUSED',reason:'no action set: the driver declares no action '
   +'specification and the caller supplied none',confirmed:[],rejected:[],budget:null});
 if(spec&&typeof spec.maskAllowed==='function')
  for(const mask of masks){
   const verdict=spec.maskAllowed(mask);
   if(verdict&&verdict.allowed===false)
    return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
     status:'REFUSED',reason:'action mask '+mask+' is not one this platform can '
      +'produce: '+verdict.reason,confirmed:[],rejected:[],budget:null});
  }

 let width;
 try{width=driver.readRam().length;}
 catch(error){return frozen({schemaVersion:SCHEMA_VERSION,revision:SEQUENCES_REVISION,
  status:'REFUSED',reason:'the driver could not be read: '
   +(error&&error.message||error),confirmed:[],rejected:[],budget:null});}

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
  let previousHorizon=0;
  for(const horizon of config.horizons){
   if(horizon>previousHorizon){metered.run(0,horizon-previousHorizon);previousHorizon=horizon;}
   const now=metered.readRam();
   for(const entry of diff(before,now,width))
    if(!firstMoved.has(entry.address))
     firstMoved.set(entry.address,{...entry,horizon});
  }
  return {firstMoved,endHash:metered.stateHash()};
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

const api={SCHEMA_VERSION,SEQUENCES_REVISION,DEFAULTS,discover,
 PRESS,HOLD,WAIT,describe,describeStep,keyOf,totalFrames};
root.FlyAgodSequences=api;
if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
