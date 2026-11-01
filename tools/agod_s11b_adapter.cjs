'use strict';
// S11B experimental adapter: continuous hold and pulse train, under one roof.
//
// WHY THIS EXISTS. Causal.probeAction holds ONE mask for the whole window and
// caps a single arm at 600 frames. The pulse train cannot be expressed through
// it, and passing 720 as `frames` is forbidden on two counts: it would
// substitute the action structure, and it exceeds the hard cap. So the train -
// and the duration-matched continuous controls at 144/360/720 that give
// RECOVERED_BY_CADENCE its meaning - run here instead.
//
// THIS IS AN INDEPENDENT IMPLEMENTATION and is labelled as one everywhere it
// reports. It reproduces the standard detector's algorithm deliberately and is
// checked against it at horizons 12 and 48 (T2); the standard detector's own
// rules are not modified.
//
// T1 is built in:
//   - the raw diff is recorded SEPARATELY and never promoted to causal evidence;
//   - truncation is detected rather than assumed absent;
//   - continuous-hold arms sample RAM at intermediate points, which runs NO
//     frames, so "no final difference" can be told apart from "no event in the
//     horizon".
const crypto=require('node:crypto');

const ADAPTER_REVISION='agod-s11b-adapter-1';
const frozen=Object.freeze.bind(Object);
const hash=bytes=>crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const diffAddresses=(before,after,limit)=>{
 const out=[];
 const length=Math.min(before.length,after.length,limit);
 for(let a=0;a<length;a++)if(before[a]!==after[a])out.push(a);
 return out;
};

/* One continuous-hold arm, with intermediate samples. The samples read RAM and
   run no frames of their own: the schedule is exactly `frames` of `mask`. */
function holdArm(driver,start,mask,frames,sampleEvery){
 driver.restore(start.snapshot);
 const before=Array.from(driver.readRam());
 const samples=[{atFrame:0,ram:before}];
 let run=0;
 if(sampleEvery&&sampleEvery>0){
  while(run<frames){
   const step=Math.min(sampleEvery,frames-run);
   driver.run(mask,step);run+=step;
   samples.push({atFrame:run,ram:Array.from(driver.readRam())});
  }
 }else{
  driver.run(mask,frames);run=frames;
  samples.push({atFrame:frames,ram:Array.from(driver.readRam())});
 }
 const after=samples[samples.length-1].ram;
 return {mask,frames,before,after,samples,framesRun:run};
}

/* One pulse-train arm: `pulses` cycles of hold+release, RAM after each cycle. */
function trainArm(driver,start,mask,pulses,hold,release,tailFrames,lastReleaseAdjust){
 driver.restore(start.snapshot);
 const before=Array.from(driver.readRam());
 const samples=[{atFrame:0,cycle:0,ram:before}];
 let run=0;
 /* R1. A negative shift used to be applied to the release of EVERY pulse, so a
    60-pulse train at delta=-3 ran 60*(4+5)=540 frames where the window should
    be H+delta=717 - short by 177 frames, and with a different train structure
    besides. The shift now lands on the FINAL release only, which keeps every
    earlier cycle exactly as declared and makes the window length exact. */
 const adjust=lastReleaseAdjust||0;
 /* R1. Clamping a negative shift to zero would silently drop frames AND merge
    the last press into the tail, so the window would no longer be the declared
    one. A shift the release cannot absorb is an error, not something to round. */
 if(release+adjust<0)throw new Error('SHIFT_EXCEEDS_RELEASE: a tail shift of '
  +adjust+' cannot be absorbed by a release of '+release
  +' frames; the window would not be the declared one');
 for(let p=0;p<pulses;p++){
  const thisRelease=(p===pulses-1)?release+adjust:release;
  driver.run(mask,hold);
  if(thisRelease)driver.run(0,thisRelease);
  run+=hold+thisRelease;
  samples.push({atFrame:run,cycle:p+1,ram:Array.from(driver.readRam())});
 }
 /* DEFECT FIXED. The neutral trajectory for a train used to be built by adding
    or removing whole CYCLES, so its windows sat at +/-12, 24, 36 frames and
    never at the +/-1..3 frames where the phase drift actually lives. A
    time-driven byte therefore slipped through even at one pulse of 12 frames,
    while continuous hold over the SAME 12 frames correctly rejected it - same
    duration, same mask, only the trajectory grid differing. The shift is now a
    tail of neutral FRAMES, which is what the standard detector means by a phase
    window. */
 if(tailFrames){driver.run(0,tailFrames);run+=tailFrames;
  samples.push({atFrame:run,cycle:pulses,ram:Array.from(driver.readRam())});}
 const after=samples[samples.length-1].ram;
 return {mask,pulses,hold,release,frames:run,tailFrames:tailFrames||0,
  lastReleaseAdjust:adjust,
  pressEdges:pulses,
  before,after,samples,framesRun:run};
}

/* The neutral reference trajectory, same idea as the standard detector: the
   neutral arm replayed at several window lengths so a byte that merely slipped
   in phase is not attributed to the action. */
function neutralWindows(driver,start,plan){
 const windows=[];
 for(let delta=-plan.shiftTolerance;delta<=plan.shiftTolerance;delta++){
  if(plan.kind==='hold'){
   const frames=plan.frames+delta;
   if(frames<1)continue;
   windows.push(holdArm(driver,start,plan.neutralMask,frames,0));
  }else{
   /* the SAME train, shifted by delta neutral FRAMES at the tail */
   if(plan.frames+delta<1)continue;
   /* positive delta: a neutral tail. negative delta: shorten the FINAL release
      only, so the press-edge count and every earlier cycle stay as declared. */
   windows.push(delta>=0
    ?trainArm(driver,start,plan.neutralMask,plan.pulses,plan.hold,plan.release,delta,0)
    :trainArm(driver,start,plan.neutralMask,plan.pulses,plan.hold,plan.release,0,delta));
  }
 }
 return windows;
}

/* One start, one plan. Mirrors evaluateStart: two neutral arms for determinism,
   a neutral trajectory, the action arm, and an alternative-mask arm. */
function evaluateStart(driver,start,plan){
 const run=(mask,overridePulses)=>plan.kind==='hold'
  ?holdArm(driver,start,mask,plan.frames,plan.sampleEvery)
  :trainArm(driver,start,mask,overridePulses===undefined?plan.pulses:overridePulses,
     plan.hold,plan.release);
 const neutralA=run(plan.neutralMask),neutralB=run(plan.neutralMask);
 const deterministic=neutralA.after.every((v,a)=>v===neutralB.after[a]);
 if(!deterministic)return frozen({startId:start.id,status:'INCONCLUSIVE',
  reason:'non-deterministic replay: the two neutral arms diverged',
  attributed:[],rawAttributed:[],specificToMask:[],
  neutralDivergedAt:diffAddresses(neutralA.after,neutralB.after,plan.maxRamBytes).slice(0,plan.maxAddressesReported)});
 const trajectory=neutralWindows(driver,start,plan);
 const onTrajectory=(address,value)=>trajectory.some(w=>w.after[address]===value);
 const action=run(plan.mask);
 /* RAW DIFF: recorded on its own and never promoted (T1.1). */
 const rawAttributed=diffAddresses(neutralA.after,action.after,plan.maxRamBytes);
 const attributed=rawAttributed.filter(a=>!onTrajectory(a,action.after[a]));
 const shiftExplained=rawAttributed.filter(a=>onTrajectory(a,action.after[a]));
 let alternativeAttributed=[],shared=[],alternativeArm=null;
 if(plan.alternativeMask!==null&&plan.alternativeMask!==undefined){
  /* run ONCE. The first version called run() again for the hash, which spent a
     whole extra arm's frames and could have observed a different state. */
  alternativeArm=run(plan.alternativeMask);
  alternativeAttributed=diffAddresses(neutralA.after,alternativeArm.after,plan.maxRamBytes)
   .filter(a=>!onTrajectory(a,alternativeArm.after[a]));
  const set=new Set(alternativeAttributed);
  shared=attributed.filter(a=>set.has(a));
 }
 const specific=attributed.filter(a=>!shared.includes(a));
 /* T1.2: did anything move at an INTERMEDIATE sample, even if the endpoint
    matched? Computed against the neutral arm's own intermediate samples so a
    time-driven byte does not count. */
 const intermediate=[];
 if(action.samples.length>2){
  for(let i=1;i<action.samples.length-1;i++){
   const neutralSame=neutralA.samples[i];
   if(!neutralSame)continue;
   const moved=diffAddresses(neutralSame.ram,action.samples[i].ram,plan.maxRamBytes);
   if(moved.length)intermediate.push({atFrame:action.samples[i].atFrame,
    movedAddresses:moved.slice(0,plan.maxAddressesReported),count:moved.length});
  }
 }
 const limit=plan.maxAddressesReported;
 const truncated=[rawAttributed,attributed,shiftExplained,alternativeAttributed,shared,specific]
  .some(list=>list.length>=limit);
 return frozen({startId:start.id,status:'OBSERVED',
  stateHash:hash(action.before),
  actionHash:hash(action.after),neutralHash:hash(neutralA.after),
  alternativeHash:alternativeArm?hash(alternativeArm.after):null,
  attributed:attributed.slice(0,limit),
  rawAttributed:rawAttributed.slice(0,limit),
  rawAttributedCount:rawAttributed.length,
  shiftExplainedAddresses:shiftExplained.slice(0,limit),
  alternativeAttributed:alternativeAttributed.slice(0,limit),
  sharedWithAlternative:shared.slice(0,limit),
  specificToMask:specific.slice(0,limit),
  neutralWindows:trajectory.length,
  /* oracle-free: addresses the NEUTRAL arm itself moved over this horizon.
     A byte here is time-driven at this duration. If the probe nevertheless
     CONFIRMS such a byte, the neutral trajectory failed to cover its drift. */
  neutralMovedAddresses:diffAddresses(neutralA.before,neutralA.after,plan.maxRamBytes).slice(0,limit),
  neutralMovedCount:diffAddresses(neutralA.before,neutralA.after,plan.maxRamBytes).length,
  intermediateMovement:frozen(intermediate.slice(0,16)),
  intermediateSamplesTaken:action.samples.length,
  reportTruncated:truncated,
  maxAddressesReported:limit,
  framesRun:action.framesRun});
}

function aggregate(perStart,limit){
 const usable=perStart.filter(e=>e.status==='OBSERVED');
 const counts=new Map(),specificCounts=new Map();
 for(const e of usable){
  for(const a of e.attributed)counts.set(a,(counts.get(a)||0)+1);
  for(const a of e.specificToMask)specificCounts.set(a,(specificCounts.get(a)||0)+1);
 }
 const confirmed=[],contradicted=[];
 for(const [address,count] of [...counts.entries()].sort((a,b)=>a[0]-b[0])){
  const record={address,starts:count,ofStarts:usable.length,
   specificStarts:specificCounts.get(address)||0};
  if(count===usable.length&&usable.length>0)confirmed.push(record);else contradicted.push(record);
 }
 return {confirmed:confirmed.slice(0,limit),contradicted:contradicted.slice(0,limit),
  usableStarts:usable.length,excludedStarts:perStart.length-usable.length};
}

/* kind: 'hold' -> {frames, sampleEvery}; 'train' -> {pulses, hold, release} */
function probe(driver,options){
 const plan={kind:options.kind,
  mask:options.mask,neutralMask:options.neutralMask===undefined?0:options.neutralMask,
  alternativeMask:options.alternativeMask===undefined?null:options.alternativeMask,
  shiftTolerance:Number.isInteger(options.shiftTolerance)?options.shiftTolerance:3,
  maxRamBytes:Number.isInteger(options.maxRamBytes)?options.maxRamBytes:2048,
  maxAddressesReported:Number.isInteger(options.maxAddressesReported)?options.maxAddressesReported:256,
  frames:options.frames,sampleEvery:Number.isInteger(options.sampleEvery)?options.sampleEvery:0,
  pulses:options.pulses,hold:options.hold,release:options.release};
 if(plan.kind==='train')plan.frames=plan.pulses*(plan.hold+plan.release);
 const perStart=(options.starts||[]).map(start=>evaluateStart(driver,start,plan));
 const summary=aggregate(perStart,plan.maxAddressesReported);
 return frozen({adapterRevision:ADAPTER_REVISION,
  independentImplementation:'this is NOT the standard Causal detector; it reproduces its algorithm and is checked against it at horizons 12 and 48 (T2)',
  plan:frozen({...plan}),
  perStart:frozen(perStart),
  confirmed:frozen(summary.confirmed),contradicted:frozen(summary.contradicted),
  usableStarts:summary.usableStarts,excludedStarts:summary.excludedStarts,
  independentStarts:(options.starts||[]).filter(s=>s.independent).length,
  anyReportTruncated:perStart.some(e=>e.reportTruncated===true),
  /* R4. This is a CONSERVATIVE indicator that a horizon is doubtful. A byte
     moved by the neutral arm may ALSO be driven by the button, so a flag here
     is an uncertainty state and NOT proof that a positive observation is an
     artefact. The six quantities below are kept separate precisely so the
     reader can see which is which. */
  phaseControlFlagMeaning:'uncertainty of the instrument at this horizon, not evidence that a confirmation is false',
  confirmedThatNeutralAlsoMoved:(()=>{
   const neutral=new Set();
   for(const e of perStart)for(const a of (e.neutralMovedAddresses||[]))neutral.add(a);
   return summary.confirmed.filter(e=>neutral.has(e.address)).map(e=>e.address);
  })(),
  framesRun:perStart.reduce((t,e)=>t+(e.framesRun||0),0)});
}

/* T1: the membership questions, kept apart from each other and from the verdict. */
function addressCoverage(result,address){
 const attributedMembership=result.confirmed.some(e=>e.address===address);
 const inAnyReportedAttributed=result.perStart.some(e=>(e.attributed||[]).includes(address));
 const rawDiffMembership=result.perStart.some(e=>(e.rawAttributed||[]).includes(address));
 const truncated=result.anyReportTruncated===true;
 return frozen({address,
  attributedMembership,inAnyReportedAttributed,
  /* recorded separately; NEVER promoted to causal evidence */
  rawDiffMembership,
  rawDiffIsNotCausalEvidence:true,
  reportTruncated:truncated,
  status:attributedMembership?'CAUSALLY_CONFIRMED'
   :(truncated?'ADDRESS_COVERAGE_UNKNOWN':'NOT_CONFIRMED'),
  statusNote:attributedMembership?'confirmed on every usable start'
   :(truncated
    ?'the report was truncated and membership in the full set is not established: this is a limit of the instrument, not the absence of a game event'
    :'the report was not truncated, so the address was considered and not confirmed')});
}

/* T1.2: distinguish a matching endpoint from no event at all. */
function horizonMovement(result,address){
 const intermediateMoved=result.perStart.some(e=>
  (e.intermediateMovement||[]).some(m=>(m.movedAddresses||[]).includes(address)));
 const endpointMoved=result.perStart.some(e=>(e.rawAttributed||[]).includes(address));
 const sampledThroughout=result.perStart.every(e=>(e.intermediateSamplesTaken||0)>2);
 return frozen({address,endpointMoved,intermediateMoved,sampledThroughout,
  /* R5. Samples every 12 frames cannot exclude a change that appears and
     disappears BETWEEN two adjacent snapshots, so the strongest honest claim is
     about the sampled points, never about the horizon. NO_EVENT_IN_HORIZON is
     withdrawn as a label. */
  outcome:endpointMoved?(intermediateMoved?'MOVED_AND_PERSISTED':'MOVED_AT_ENDPOINT')
   :(intermediateMoved?'TRANSIENT_WITHIN_WINDOW'
     :(sampledThroughout?'NO_CHANGE_AT_SAMPLED_POINTS':'FINAL_STATE_UNCHANGED')),
  samplingIntervalFrames:12,
  cannotExcludeBetweenSamples:true,
  note:sampledThroughout
   ?'no change at the sampled points; a transient entirely between two adjacent snapshots is NOT excluded'
   :'intermediate samples do not cover the horizon, so even the sampled-points claim is limited to the endpoints'});
}

module.exports={ADAPTER_REVISION,probe,addressCoverage,horizonMovement,
 /* neutralWindows is exported so the window geometry can be tested directly
    (R1): the shift lives here, not in the arms, and a test that only called
    trainArm would not exercise it. */
 holdArm,trainArm,neutralWindows,diffAddresses,hash};
