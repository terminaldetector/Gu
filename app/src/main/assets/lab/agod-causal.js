/* Experimental AGOD causal validation (TZ v2.0, AGOD-05 / E3).
   Isolated replay only: this module never touches a live session. It restores a
   caller-supplied snapshot, replays fixed action arms from it, and attributes a
   RAM change to an action only when a neutral arm from the same snapshot does
   not produce that change. Attribution is evidence, not game meaning: nothing
   here infers polarity, reward or a goal. Not wired into any production screen. */
(function(root){'use strict';
const SCHEMA_VERSION=2,DETECTOR_REVISION='agod-causal-e3-2';
/* G3. maxRamBytes is the width of the comparison, and its default is the NES
   internal RAM. It was also the hard cap at 65536, which is exactly Sega's
   work-RAM window and BELOW the RAM GU declares for SNES (131072), so on the
   wider platforms an address above the cap could not be compared at all and a
   real effect read as NO-EFFECT. The default is unchanged - every historical
   run declared nothing and must reproduce - and the cap now reaches the widest
   width GU declares.

   maxMask is new and is the width of the ACTION, for the same reason: the mask
   check here was a literal 255, so the four extra buttons on a Sega or SNES pad
   (bits 8..11) were rejected before they were ever pressed. Its default is 255,
   so a caller that declares nothing still gets the eight-button check it got
   before; its cap is 4095, the widest single pad GU describes. A wider action
   than that is a deliberate decision and has to raise the cap on purpose. */
const DEFAULT_LIMITS=Object.freeze({maxStarts:8,maxArmsPerStart:16,maxFramesPerArm:120,maxRamBytes:2048,maxAddressesReported:64,maxTotalFrames:40000,maxShiftTolerance:4,maxMask:255});
/* maxAddressesReported reaches the widest RAM GU declares, so a caller that
   needs a complete list - agod-pipeline.js, which derives its candidates from
   it - can ask for one instead of silently receiving a prefix. Measured before
   raising it: across 48 probes on six NES fixtures the worst start attributed
   8 addresses, so no NES result can move. */
const CAPS=Object.freeze({maxStarts:32,maxArmsPerStart:32,maxFramesPerArm:600,maxRamBytes:131072,maxAddressesReported:131072,maxTotalFrames:400000,maxShiftTolerance:12,maxMask:4095});

const frozen=value=>Object.freeze(value);
function clampLimits(requested){
 const limits={...DEFAULT_LIMITS};
 for(const key of Object.keys(DEFAULT_LIMITS)){
  if(requested&&Object.prototype.hasOwnProperty.call(requested,key)){
   const value=requested[key];
   if(!Number.isInteger(value)||value<1)throw new Error('causal limit must be a positive integer: '+key);
   if(value>CAPS[key])throw new Error('causal limit above hard cap: '+key);
   limits[key]=value;
  }
 }
 return frozen(limits);
}

/* A start is independent only if its own state differs from every other start's.
   A fresh identifier is not independence; the caller supplies the state hash. */
function validateStarts(starts,limits){
 if(!Array.isArray(starts)||!starts.length)throw new Error('at least one start is required');
 if(starts.length>limits.maxStarts)throw new Error('too many starts');
 const seen=new Map();
 return starts.map((start,index)=>{
  if(!start||typeof start.id!=='string'||!start.id)throw new Error('start '+index+' needs an id');
  if(typeof start.stateHash!=='string'||!start.stateHash)throw new Error('start '+index+' needs a stateHash');
  const duplicate=seen.has(start.stateHash)?seen.get(start.stateHash):null;
  seen.set(start.stateHash,start.id);
  return frozen({id:start.id,stateHash:start.stateHash,snapshot:start.snapshot,
   duplicateOf:duplicate,independent:duplicate===null});
 });
}

function diffAddresses(before,after,limit){
 const out=[];
 const length=Math.min(before.length,after.length,limit);
 for(let address=0;address<length;address++)if(before[address]!==after[address])out.push(address);
 return out;
}

/* One arm: restore the snapshot, hold one mask for the whole window, read RAM. */
function runArm(driver,start,mask,frames){
 driver.restore(start.snapshot);
 const before=driver.readRam();
 driver.run(mask,frames);
 const after=driver.readRam();
 return {mask,before:Array.from(before),after:Array.from(after)};
}

/* Why a plain action-vs-neutral difference is not enough.

   Holding a button costs the game loop CPU time. On a real cartridge that can
   make the loop miss a vblank, so after the same number of host frames the
   action arm has executed FEWER game iterations than the neutral arm. Every
   time-driven byte - frame counters, timers, periodic decoys - is then simply
   phase-shifted, and a naive difference reports it as caused by the button.

   Measured on the project's own controlled cartridge (seed 2): the reset button
   held for 12 frames produced exactly the neutral state at 11 frames
   (frameCounter 85, timer 5, noise 103), and two other masks landed on the
   neutral state three iterations back. The effect is real and systematic, not
   noise.

   So the neutral arm is replayed at several window lengths around the nominal
   one, giving a per-address reference trajectory. An address is attributed to
   the action only when its value is off that trajectory entirely. A byte that
   merely slipped in phase stays unattributed, without the module needing to
   know which byte happens to be a clock. */
function neutralTrajectory(driver,start,plan,limits){
 const windows=[];
 for(let delta=-plan.shiftTolerance;delta<=plan.shiftTolerance;delta++){
  const frames=plan.frames+delta;
  if(frames<1||frames>limits.maxFramesPerArm)continue;
  windows.push(runArm(driver,start,plan.neutralMask,frames));
 }
 return windows;
}

/* G3. THE REPORT BOUND IS NOT THE EVIDENCE.
   maxAddressesReported bounds what a record SHOWS. It used to bound what the
   aggregation COUNTED as well, because evaluateStart returned the already
   truncated list and aggregate() counted over that - so an action that changed
   more addresses than the bound had its later addresses dropped before a single
   start was compared with another, and a probe whose only agreeing address sat
   past the bound came back NO-EFFECT. A truncated report had become an absence
   of causality, which is the one inference this module exists to prevent.

   So evaluateStart now returns the record AND the full lists beside it: the
   record stays bounded and says how much it is hiding, and the aggregation runs
   over everything that was observed. The full lists are deliberately NOT put in
   the returned result - on a 128 KiB platform they would be a copy of the
   address space per start - they are handed to probeAction and dropped. */
function evaluateStart(driver,start,plan,limits){
 const bound=limits.maxAddressesReported;
 const shown=list=>({list:list.slice(0,bound),total:list.length,
  truncated:list.length>bound});
 const neutralA=runArm(driver,start,plan.neutralMask,plan.frames);
 const neutralB=runArm(driver,start,plan.neutralMask,plan.frames);
 const shamStable=neutralA.after.every((value,address)=>value===neutralB.after[address]);
 if(!shamStable){
  const diverged=shown(diffAddresses(neutralA.after,neutralB.after,limits.maxRamBytes));
  return {full:{attributed:[],specificToMask:[]},
   record:frozen({startId:start.id,stateHash:start.stateHash,status:'INCONCLUSIVE',
   reason:'non-deterministic replay: the two neutral arms diverged',
   shamDivergedAt:diverged.list,
   shamDivergedTotal:diverged.total,shamDivergedTruncated:diverged.truncated,
   attributed:[],rawAttributed:[],alternativeAttributed:[],sharedWithAlternative:[],specificToMask:[],
   attributedTotal:0,attributedTruncated:false})};
 }
 const trajectory=neutralTrajectory(driver,start,plan,limits);
 const onTrajectory=(address,value)=>trajectory.some(window=>window.after[address]===value);
 const action=runArm(driver,start,plan.mask,plan.frames);
 const rawAttributed=diffAddresses(neutralA.after,action.after,limits.maxRamBytes);
 const attributed=rawAttributed.filter(address=>!onTrajectory(address,action.after[address]));
 const shiftExplained=rawAttributed.filter(address=>onTrajectory(address,action.after[address]));
 let alternativeAttributed=[],shared=[];
 if(plan.alternativeMask!==null&&plan.alternativeMask!==undefined){
  const alternative=runArm(driver,start,plan.alternativeMask,plan.frames);
  alternativeAttributed=diffAddresses(neutralA.after,alternative.after,limits.maxRamBytes)
   .filter(address=>!onTrajectory(address,alternative.after[address]));
  const alternativeSet=new Set(alternativeAttributed);
  shared=attributed.filter(address=>alternativeSet.has(address));
 }
 /* `shared` is a list, so membership here was a linear scan inside a filter -
    quadratic in the number of attributed addresses, which is 2048 or more on a
    wide platform. A set, because this path now really does run over thousands
    of addresses instead of the five or six a NES probe produces. */
 const sharedSet=new Set(shared);
 const specific=attributed.filter(address=>!sharedSet.has(address));
 const attr=shown(attributed),drift=shown(diffAddresses(neutralA.before,neutralA.after,limits.maxRamBytes));
 return {full:{attributed,specificToMask:specific},
  record:frozen({startId:start.id,stateHash:start.stateHash,status:'OBSERVED',
  attributed:attr.list,
  attributedTotal:attr.total,attributedTruncated:attr.truncated,
  rawAttributed:rawAttributed.slice(0,bound),
  rawAttributedTotalThisStart:rawAttributed.length,
  shiftExplainedAddresses:shiftExplained.slice(0,bound),
  shiftExplainedTotalThisStart:shiftExplained.length,
  alternativeAttributed:alternativeAttributed.slice(0,bound),
  sharedWithAlternative:shared.slice(0,bound),
  specificToMask:specific.slice(0,bound),
  specificToMaskTotal:specific.length,
  neutralWindows:trajectory.length,
  neutralDriftAddresses:drift.list,
  neutralDriftTotal:drift.total})};
}

/* Cross-start aggregation.

   Agreement across independent starts is what turns a single observation into a
   causal claim. An address seen in some starts and absent in others is recorded
   as a contradiction, not quietly averaged away. */
function aggregate(evaluated,limits){
 /* counted over the FULL per-start lists, never over the bounded records */
 const usable=evaluated.filter(entry=>entry.record.status==='OBSERVED');
 const counts=new Map(),specificCounts=new Map();
 for(const entry of usable){
  for(const address of entry.full.attributed)counts.set(address,(counts.get(address)||0)+1);
  for(const address of entry.full.specificToMask)specificCounts.set(address,(specificCounts.get(address)||0)+1);
 }
 const confirmed=[],contradicted=[];
 for(const [address,count] of [...counts.entries()].sort((a,b)=>a[0]-b[0])){
  const record={address,starts:count,ofStarts:usable.length,specificStarts:specificCounts.get(address)||0};
  if(count===usable.length&&usable.length>0)confirmed.push(record);else contradicted.push(record);
 }
 /* The STATUS is decided by the complete count, so a bounded report can no
    longer read as no effect; the bound still applies to what is shown, and how
    much is hidden is stated rather than left to be noticed. */
 return {confirmed:confirmed.slice(0,limits.maxAddressesReported),
  contradicted:contradicted.slice(0,limits.maxAddressesReported),
  confirmedTotal:confirmed.length,contradictedTotal:contradicted.length,
  confirmedTruncated:confirmed.length>limits.maxAddressesReported,
  contradictedTruncated:contradicted.length>limits.maxAddressesReported,
  usableStarts:usable.length,excludedStarts:evaluated.length-usable.length};
}

/* driver: { restore(snapshot), run(mask, frames), readRam() -> array-like }
   The driver owns the emulator. This module performs no I/O of its own. */
function probeAction(driver,options){
 if(!driver||typeof driver.restore!=='function'||typeof driver.run!=='function'||typeof driver.readRam!=='function')
  throw new Error('driver must provide restore, run and readRam');
 const limits=clampLimits(options&&options.limits);
 const starts=validateStarts(options&&options.starts,limits);
 const frames=options&&options.frames;
 if(!Number.isInteger(frames)||frames<1||frames>limits.maxFramesPerArm)throw new Error('frames must be 1..'+limits.maxFramesPerArm);
 const mask=options.mask;
 if(!Number.isInteger(mask)||mask<0||mask>limits.maxMask)
  throw new Error('mask must be an integer 0..'+limits.maxMask
   +' (the declared action width); got '+mask);
 const neutralMask=Number.isInteger(options.neutralMask)?options.neutralMask:0;
 if(mask===neutralMask)throw new Error('the probed mask must differ from the neutral mask');
 const alternativeMask=Number.isInteger(options.alternativeMask)?options.alternativeMask:null;
 const shiftTolerance=Number.isInteger(options.shiftTolerance)?options.shiftTolerance:3;
 if(shiftTolerance<0||shiftTolerance>limits.maxShiftTolerance)throw new Error('shiftTolerance must be 0..'+limits.maxShiftTolerance);
 const trajectoryArms=2*shiftTolerance+1;
 const armsPerStart=(alternativeMask===null?3:4)+trajectoryArms;
 const totalFrames=starts.length*armsPerStart*(frames+shiftTolerance);
 if(armsPerStart>limits.maxArmsPerStart)throw new Error('too many arms per start');
 if(totalFrames>limits.maxTotalFrames)throw new Error('causal probe exceeds the total frame budget');
 const plan={mask,neutralMask,alternativeMask,frames,shiftTolerance};
 const evaluated=starts.map(start=>evaluateStart(driver,start,plan,limits));
 const summary=aggregate(evaluated,limits);
 /* the full lists stay here and are dropped; only the bounded records travel */
 const perStart=evaluated.map(entry=>entry.record);
 const independentStarts=starts.filter(start=>start.independent).length;
 /* Reported so the phase-shift confound stays visible instead of being silently
    absorbed: how many addresses a naive difference would have claimed, and how
    many of those were explained by the neutral trajectory alone. */
 /* These two are the phase-shift confound made visible, so they must count the
    WHOLE list and not the bounded view of it - summing the truncated arrays
    understated exactly the quantity they exist to expose. */
 const rawAttributedTotal=perStart.reduce((sum,entry)=>
  sum+(Number.isInteger(entry.rawAttributedTotalThisStart)?entry.rawAttributedTotalThisStart
   :(entry.rawAttributed?entry.rawAttributed.length:0)),0);
 const shiftExplainedTotal=perStart.reduce((sum,entry)=>
  sum+(Number.isInteger(entry.shiftExplainedTotalThisStart)?entry.shiftExplainedTotalThisStart
   :(entry.shiftExplainedAddresses?entry.shiftExplainedAddresses.length:0)),0);
 return frozen({schemaVersion:SCHEMA_VERSION,detectorRevision:DETECTOR_REVISION,
  plan:frozen({...plan,armsPerStart,totalFrames}),
  starts:starts.map(start=>frozen({id:start.id,stateHash:start.stateHash,independent:start.independent,duplicateOf:start.duplicateOf})),
  independentStarts,
  perStart,
  confirmed:summary.confirmed,contradicted:summary.contradicted,
  /* what the two lists would have held without the report bound, so a caller
     that needs completeness can see that it is not getting it */
  confirmedTotal:summary.confirmedTotal,contradictedTotal:summary.contradictedTotal,
  confirmedTruncated:summary.confirmedTruncated,
  contradictedTruncated:summary.contradictedTruncated,
  usableStarts:summary.usableStarts,excludedStarts:summary.excludedStarts,
  rawAttributedTotal,shiftExplainedTotal,
  /* Deliberately absent: polarity, role, reward, confidence. AGOD-05 establishes
     that an action changes an address, nothing about what the change means. */
  polarity:'unknown',role:'unknown',rewardStatus:'UNKNOWN',
  /* confirmedTotal, NOT confirmed.length: the bounded array is a view */
  causalStatus:summary.usableStarts===0?'INCONCLUSIVE':(summary.confirmedTotal?'CAUSAL-EVIDENCE':'NO-EFFECT'),
  limits});
}

const api={SCHEMA_VERSION,DETECTOR_REVISION,DEFAULT_LIMITS,CAPS,probeAction};
root.FlyAgodCausal=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
