'use strict';
// T2: is the experimental adapter the same instrument as Causal.probeAction?
//
// RECOVERED_BY_CADENCE compares a pulse train against a continuous control
// which, at 144/360/720 frames, runs in the adapter rather than in the standard
// detector. If the adapter behaves differently, that comparison is between two
// instruments and not between two action structures. So this check GATES the
// synthetic trials: they do not start until it passes, and on divergence both
// results are kept, the cause is localised, and RECOVERED_BY_CADENCE is not
// assigned at all until then.
//
// R3 / A3. Version 1 of this file DECLARED that it compared the action, neutral
// and alternative RAM hashes. It did not. It computed a standardHashes local
// with neutral:null and never read it, and the gate passed 8 of 8 on the
// address sets alone. The declared contract is now met, and by a method that
// does not modify either instrument: both run against a RECORDING DRIVER that
// captures, for every arm, the ordered (mask,frames) schedule actually issued
// and the hash of the RAM the arm ended on. The two instruments are then
// compared arm by arm, in order. That is strictly stronger than comparing the
// hashes of three named arms: it would catch an extra arm, a missing arm, a
// wrong window length, or a right answer reached by a different schedule.
//
// THREE SERIES, because one of them cannot exist:
//
//   T2a  adapter continuous hold vs standard detector, horizons 12 and 48,
//        shiftTolerance 3. The pre-registered comparison.
//
//   T2b  adapter PULSE TRAIN with release 0 vs standard detector continuous
//        hold of the same duration, at 1, 4 and 12 pulses (12, 48, 144
//        frames), shiftTolerance 0. A train of zero release is frame-for-frame
//        a continuous hold, so this drives the adapter's TRAIN code path
//        against the reference instrument - coverage version 1 did not have.
//        It tests the train code path, NOT cadence: with release 0 there is one
//        press edge, not one per pulse.
//        shiftTolerance is 0 here because a negative phase window cannot be
//        absorbed by a release of 0. That is a real limit of the instrument and
//        is recorded as one below, not worked around.
//
//   T2c  adapter pulse train at HOLD 4 RELEASE 8, shiftTolerance 3, at 1, 4,
//        12 and 30 pulses, against an INDEPENDENT reimplementation written in
//        this file. The standard detector cannot express a train at all, so
//        there is no reference instrument for the real train; an independent
//        implementation of the same declared algorithm is the next best thing,
//        and it covers the real trajectory machinery that T2b cannot.
//
// NO ROM BYTES ENTER ANY ARTEFACT.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),
      crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const Causal=require('../app/src/main/assets/lab/agod-causal.js'),
      Adapter=require('./agod_s11b_adapter.cjs'),
      Host=require('./agod_s11b_host.cjs');
const Provenance=require('./agod_provenance.cjs');

const HORIZONS=[12,48],SHIFT=3,STARTS=3,MAX_ADDRESSES=256;
const ZERO_RELEASE_PULSES=[1,4,12];
const TRAIN_PULSES=[1,4,12,30],TRAIN_HOLD=4,TRAIN_RELEASE=8;
const rows=[];
/* R6. The SHA256 of every source file this run depended on, as the bytes
   were on disk when it started, and which of them differ from HEAD. A commit
   plus a dirty flag does not say either of those things. */
const provenance=Provenance.record({tool:'tools/agod_s11b_t2_equivalence.cjs',
 sources:['tools/make_agod_test_rom.py']});
const report={type:'gu-agod-s11b-t2-equivalence',version:2,
 supersedes:'version 1, whose declared hash comparison was never performed (R3 / A3)',
 question:'does the experimental adapter produce the same result as Causal.probeAction on identical starts, masks and horizons, by the same arms?',
 gate:'the synthetic trials do not start until this passes; on divergence both results are kept, the cause is localised, and RECOVERED_BY_CADENCE is withheld',
 horizons:HORIZONS,shiftTolerance:SHIFT,startsPerTrial:STARTS,
 series:{T2a:'continuous hold vs the standard detector, shiftTolerance 3',
  T2b:'pulse train with release 0 vs the standard detector continuous hold of the same duration, shiftTolerance 0: the train code path against the reference instrument',
  T2c:'pulse train HOLD 4 RELEASE 8, shiftTolerance 3, vs an independent reimplementation in this file, compared arm by arm: the only available check on the real train'},
 compared:['the ordered arm schedule actually issued, (mask,frames) per run',
  'the RAM hash each arm ended on, arm by arm',
  'the action, neutral and alternative arm hashes by name',
  'attributed, raw, shift-explained, specific and shared address sets',
  'confirmed and contradicted address sets',
  'usable and excluded starts',
  'the shift tolerance each instrument reports it used',
  'the neutral trajectory arm count',
  'the total frames actually emulated and the wall-clock duration'],
 provenance,status:'RUNNING',rows};
const write=()=>{if(process.env.AGOD_T2_REPORT)
 fs.writeFileSync(process.env.AGOD_T2_REPORT,JSON.stringify(report,null,2)+'\n');};write();

const hash=bytes=>crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const sameSet=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/* Wraps a driver and records every ARM: an arm begins at restore() and ends at
   the next restore() or at finish(). Neither instrument is modified. */
function recordingDriver(raw){
 const arms=[];
 let schedule=[],armFrames=0,totalFrames=0,open=false;
 const close=()=>{if(!open)return;
  arms.push({index:arms.length,schedule,frames:armFrames,endHash:hash(raw.readRam())});
  schedule=[];armFrames=0;open=false;};
 return {arms,
  restore(s){close();raw.restore(s);open=true;},
  run(mask,count){schedule.push([mask,count]);armFrames+=count;totalFrames+=count;
   return raw.run(mask,count);},
  readRam:()=>raw.readRam(),
  snapshot:()=>raw.snapshot(),
  stateHash:()=>raw.stateHash(),
  finish(){close();return {arms,totalFrames};},
  totalFrames:()=>totalFrames};
}

/* An INDEPENDENT implementation of the declared train algorithm, written here
   and not calling the adapter, so T2c compares two implementations rather than
   one implementation with itself. */
function independentTrain(driver,starts,options){
 const {mask,neutralMask,alternativeMask,pulses,hold,release,shiftTolerance,maxRamBytes}=options;
 const arm=(start,armMask,count,tail,lastAdjust)=>{
  driver.restore(start.snapshot);
  for(let p=0;p<count;p++){
   const r=(p===count-1)?release+(lastAdjust||0):release;
   driver.run(armMask,hold);
   if(r>0)driver.run(0,r);
  }
  if(tail)driver.run(0,tail);
  return Array.from(driver.readRam());
 };
 const diff=(a,b)=>{const out=[];
  for(let i=0;i<Math.min(a.length,b.length,maxRamBytes);i++)if(a[i]!==b[i])out.push(i);
  return out;};
 const perStart=starts.map(start=>{
  const neutralA=arm(start,neutralMask,pulses,0,0);
  const neutralB=arm(start,neutralMask,pulses,0,0);
  if(!neutralA.every((v,i)=>v===neutralB[i]))
   return {startId:start.id,status:'INCONCLUSIVE',attributed:[],rawAttributed:[]};
  const windows=[];
  for(let d=-shiftTolerance;d<=shiftTolerance;d++){
   if(pulses*(hold+release)+d<1)continue;
   windows.push(d>=0?arm(start,neutralMask,pulses,d,0):arm(start,neutralMask,pulses,0,d));
  }
  const onTrajectory=(address,value)=>windows.some(w=>w[address]===value);
  const action=arm(start,mask,pulses,0,0);
  const raw=diff(neutralA,action);
  const attributed=raw.filter(a=>!onTrajectory(a,action[a]));
  const shiftExplained=raw.filter(a=>onTrajectory(a,action[a]));
  let alternativeAttributed=[],shared=[];
  if(alternativeMask!==null&&alternativeMask!==undefined){
   const alternative=arm(start,alternativeMask,pulses,0,0);
   alternativeAttributed=diff(neutralA,alternative).filter(a=>!onTrajectory(a,alternative[a]));
   const set=new Set(alternativeAttributed);
   shared=attributed.filter(a=>set.has(a));
  }
  return {startId:start.id,status:'OBSERVED',
   attributed,rawAttributed:raw,shiftExplainedAddresses:shiftExplained,
   alternativeAttributed,sharedWithAlternative:shared,
   specificToMask:attributed.filter(a=>!shared.includes(a)),
   neutralWindows:windows.length,
   actionHash:hash(action),neutralHash:hash(neutralA)};
 });
 const usable=perStart.filter(e=>e.status==='OBSERVED');
 const counts=new Map();
 for(const e of usable)for(const a of e.attributed)counts.set(a,(counts.get(a)||0)+1);
 const confirmed=[],contradicted=[];
 for(const [address,count] of [...counts.entries()].sort((a,b)=>a[0]-b[0]))
  (count===usable.length&&usable.length>0?confirmed:contradicted).push(address);
 return {perStart,confirmed,contradicted,usableStarts:usable.length,
  excludedStarts:perStart.length-usable.length};
}

function namedArms(arms,plan){
 /* Both implementations issue arms in the same declared order: neutral,
    neutral, the trajectory windows, action, alternative. */
 const perStartArms=(plan.alternativeMask===null?3:4)+plan.trajectoryArms;
 const out=[];
 for(let s=0;s*perStartArms<arms.length;s++){
  const slice=arms.slice(s*perStartArms,(s+1)*perStartArms);
  if(slice.length<perStartArms)break;
  out.push({startIndex:s,
   neutralA:slice[0]?slice[0].endHash:null,
   neutralB:slice[1]?slice[1].endHash:null,
   trajectory:slice.slice(2,2+plan.trajectoryArms).map(a=>a.endHash),
   action:slice[2+plan.trajectoryArms]?slice[2+plan.trajectoryArms].endHash:null,
   alternative:plan.alternativeMask===null?null
    :(slice[3+plan.trajectoryArms]?slice[3+plan.trajectoryArms].endHash:null)});
 }
 return out;
}

function buildStarts(driver){
 const pristine=driver.snapshot();
 const starts=[];
 driver.restore(pristine);
 for(let i=0;i<STARTS;i++){
  driver.run(0,17+i*7);
  starts.push({id:'s'+i,stateHash:driver.stateHash(),
   snapshot:driver.snapshot(),independent:true});
 }
 return starts;
}
const LIMITS={maxFramesPerArm:600,maxAddressesReported:MAX_ADDRESSES,
 maxStarts:8,maxArmsPerStart:32,maxRamBytes:2048,maxTotalFrames:400000,maxShiftTolerance:12};

function comparePerStart(standard,adapted){
 const perStart=[];
 for(let i=0;i<Math.max(standard.perStart.length,adapted.perStart.length);i++){
  const s=standard.perStart[i]||{},a=adapted.perStart[i]||{};
  perStart.push({startIndex:i,
   standardStatus:s.status,adapterStatus:a.status,statusMatch:s.status===a.status,
   attributedMatch:sameSet(s.attributed||[],a.attributed||[]),
   standardAttributed:(s.attributed||[]).length,adapterAttributed:(a.attributed||[]).length,
   rawMatch:sameSet(s.rawAttributed||[],a.rawAttributed||[]),
   shiftExplainedMatch:sameSet(s.shiftExplainedAddresses||[],a.shiftExplainedAddresses||[]),
   specificMatch:sameSet(s.specificToMask||[],a.specificToMask||[]),
   sharedMatch:sameSet(s.sharedWithAlternative||[],a.sharedWithAlternative||[]),
   neutralWindowsMatch:s.neutralWindows===a.neutralWindows,
   standardNeutralWindows:s.neutralWindows,adapterNeutralWindows:a.neutralWindows});
 }
 return perStart;
}
const setsAgree=perStart=>perStart.every(e=>e.statusMatch&&e.attributedMatch&&e.rawMatch
 &&e.shiftExplainedMatch&&e.specificMatch&&e.sharedMatch&&e.neutralWindowsMatch);

try{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gu-agod-t2-'));
 const seeds=(process.env.AGOD_T2_SEEDS||'0,200').split(',').map(Number);
 const romOf=seed=>{
  const out=path.join(directory,'rom-'+seed+'.json');
  execFileSync(process.env.PYTHON||'python3',
   ['tools/make_agod_test_rom.py','--seed',String(seed),'--out',out]);
  return Buffer.from(JSON.parse(fs.readFileSync(out)).base64,'base64');
 };
 const bootHost=bytes=>Host.createHost({bytes,
  entry:{bootFrames:60,startPulses:0,gapFrames:0,settleFrames:0},hold:4});

 for(const seed of seeds){
  const bytes=romOf(seed);

  /* ---- T2a: continuous hold against the standard detector ---- */
  for(const horizon of HORIZONS)for(const mask of [2,64]){
   const alternative=mask===1?2:1;
   const plain=bootHost(bytes).driver;
   const starts=buildStarts(plain);
   const standardRecorder=recordingDriver(plain);
   const t0=Date.now();
   const standard=Causal.probeAction(standardRecorder,{starts,mask,neutralMask:0,
    alternativeMask:alternative,frames:horizon,shiftTolerance:SHIFT,limits:LIMITS});
   const standardTime=Date.now()-t0;
   const standardRun=standardRecorder.finish();
   const adapterRecorder=recordingDriver(plain);
   const t1=Date.now();
   const adapted=Adapter.probe(adapterRecorder,{kind:'hold',starts,mask,neutralMask:0,
    alternativeMask:alternative,frames:horizon,shiftTolerance:SHIFT,
    maxAddressesReported:MAX_ADDRESSES,sampleEvery:0});
   const adapterTime=Date.now()-t1;
   const adapterRun=adapterRecorder.finish();

   const planShape={alternativeMask:alternative,trajectoryArms:2*SHIFT+1};
   const standardNamed=namedArms(standardRun.arms,planShape);
   const adapterNamed=namedArms(adapterRun.arms,planShape);
   const perStart=comparePerStart(standard,adapted);
   const armScheduleMatch=standardRun.arms.length===adapterRun.arms.length
    &&standardRun.arms.every((arm,i)=>same(arm.schedule,adapterRun.arms[i].schedule));
   const armHashMatch=standardRun.arms.length===adapterRun.arms.length
    &&standardRun.arms.every((arm,i)=>arm.endHash===adapterRun.arms[i].endHash);
   const namedHashMatch=same(standardNamed,adapterNamed);
   const confirmedMatch=sameSet(standard.confirmed.map(e=>e.address),adapted.confirmed.map(e=>e.address));
   const contradictedMatch=sameSet(standard.contradicted.map(e=>e.address),adapted.contradicted.map(e=>e.address));
   const startsMatch=standard.usableStarts===adapted.usableStarts
    &&standard.excludedStarts===adapted.excludedStarts;
   const shiftMatch=standard.plan.shiftTolerance===adapted.plan.shiftTolerance;
   const framesMatch=standardRun.totalFrames===adapterRun.totalFrames;
   const equivalent=setsAgree(perStart)&&confirmedMatch&&contradictedMatch
    &&armScheduleMatch&&armHashMatch&&namedHashMatch&&startsMatch&&shiftMatch&&framesMatch;
   rows.push({series:'T2a',seed,horizon,mask,alternative,shiftTolerance:SHIFT,equivalent,
    armCountStandard:standardRun.arms.length,armCountAdapter:adapterRun.arms.length,
    armScheduleMatch,armHashMatch,namedHashMatch,
    namedArmHashes:{standard:standardNamed,adapter:adapterNamed},
    confirmedMatch,contradictedMatch,startsMatch,shiftMatch,framesMatch,
    standardShiftTolerance:standard.plan.shiftTolerance,
    adapterShiftTolerance:adapted.plan.shiftTolerance,
    standardConfirmed:standard.confirmed.map(e=>e.address).slice(0,16),
    adapterConfirmed:adapted.confirmed.map(e=>e.address).slice(0,16),
    standardUsableStarts:standard.usableStarts,adapterUsableStarts:adapted.usableStarts,
    standardExcludedStarts:standard.excludedStarts,adapterExcludedStarts:adapted.excludedStarts,
    framesEmulated:{standard:standardRun.totalFrames,adapter:adapterRun.totalFrames},
    wallClockMs:{standard:standardTime,adapter:adapterTime},
    perStart,
    divergenceDetail:equivalent?null:{
     armsDiffering:standardRun.arms.map((arm,i)=>({index:i,
      scheduleStandard:arm.schedule,
      scheduleAdapter:adapterRun.arms[i]?adapterRun.arms[i].schedule:null,
      hashMatch:adapterRun.arms[i]?arm.endHash===adapterRun.arms[i].endHash:false}))
      .filter(e=>!e.hashMatch||!same(e.scheduleStandard,e.scheduleAdapter)).slice(0,8),
     setDivergence:perStart.filter(e=>!(e.statusMatch&&e.attributedMatch&&e.rawMatch
      &&e.shiftExplainedMatch&&e.specificMatch&&e.sharedMatch&&e.neutralWindowsMatch))}});
   write();
  }

  /* ---- T2b: the train code path against the reference instrument ---- */
  for(const pulses of ZERO_RELEASE_PULSES)for(const mask of [2,64]){
   const alternative=mask===1?2:1;
   const frames=pulses*TRAIN_HOLD;
   const plain=bootHost(bytes).driver;
   const starts=buildStarts(plain);
   const standardRecorder=recordingDriver(plain);
   const t0=Date.now();
   const standard=Causal.probeAction(standardRecorder,{starts,mask,neutralMask:0,
    alternativeMask:alternative,frames,shiftTolerance:0,limits:LIMITS});
   const standardTime=Date.now()-t0;
   const standardRun=standardRecorder.finish();
   const adapterRecorder=recordingDriver(plain);
   const t1=Date.now();
   const adapted=Adapter.probe(adapterRecorder,{kind:'train',starts,mask,neutralMask:0,
    alternativeMask:alternative,pulses,hold:TRAIN_HOLD,release:0,shiftTolerance:0,
    maxAddressesReported:MAX_ADDRESSES});
   const adapterTime=Date.now()-t1;
   const adapterRun=adapterRecorder.finish();
   const perStart=comparePerStart(standard,adapted);
   const armHashMatch=standardRun.arms.length===adapterRun.arms.length
    &&standardRun.arms.every((arm,i)=>arm.endHash===adapterRun.arms[i].endHash);
   const armFramesMatch=standardRun.arms.length===adapterRun.arms.length
    &&standardRun.arms.every((arm,i)=>arm.frames===adapterRun.arms[i].frames);
   /* the SCHEDULES differ on purpose: the standard detector issues one run of
      `frames`, the adapter issues `pulses` runs of `hold`. Frame-for-frame the
      button state is the same, which is exactly what is being tested. */
   const confirmedMatch=sameSet(standard.confirmed.map(e=>e.address),adapted.confirmed.map(e=>e.address));
   const contradictedMatch=sameSet(standard.contradicted.map(e=>e.address),adapted.contradicted.map(e=>e.address));
   const equivalent=setsAgree(perStart)&&confirmedMatch&&contradictedMatch
    &&armHashMatch&&armFramesMatch
    &&standardRun.totalFrames===adapterRun.totalFrames
    &&standard.usableStarts===adapted.usableStarts;
   rows.push({series:'T2b',seed,pulses,hold:TRAIN_HOLD,release:0,frames,mask,alternative,
    shiftTolerance:0,equivalent,
    armHashMatch,armFramesMatch,confirmedMatch,contradictedMatch,
    scheduleDiffersByDesign:'the standard detector issues one run of '+frames
     +' frames, the adapter issues '+pulses+' runs of '+TRAIN_HOLD
     +'; the button state is identical frame for frame, which is the point of this series',
    framesEmulated:{standard:standardRun.totalFrames,adapter:adapterRun.totalFrames},
    wallClockMs:{standard:standardTime,adapter:adapterTime},
    standardConfirmed:standard.confirmed.map(e=>e.address).slice(0,16),
    adapterConfirmed:adapted.confirmed.map(e=>e.address).slice(0,16),
    pressEdges:1,pressEdgesNote:'a train of zero release has ONE press edge, not one per pulse: this series tests the train code path, not cadence',
    perStart,
    divergenceDetail:equivalent?null:perStart.filter(e=>!(e.statusMatch&&e.attributedMatch
     &&e.rawMatch&&e.shiftExplainedMatch&&e.specificMatch&&e.sharedMatch))});
   write();
  }

  /* ---- T2c: the real train against an independent implementation ---- */
  for(const pulses of TRAIN_PULSES)for(const mask of [2,64]){
   const alternative=mask===1?2:1;
   const plain=bootHost(bytes).driver;
   const starts=buildStarts(plain);
   /* Recorded on BOTH sides, as in T2a. The negative control for this file -
      reordering the adapter's arms - changed no address set at all and was
      caught only by the arm sequence, so a series without it is weaker than it
      looks. The independent implementation issues its arms in the same
      declared order, so the two sequences are directly comparable. */
   const adapterRecorder=recordingDriver(plain);
   const t0=Date.now();
   const adapted=Adapter.probe(adapterRecorder,{kind:'train',starts,mask,neutralMask:0,
    alternativeMask:alternative,pulses,hold:TRAIN_HOLD,release:TRAIN_RELEASE,
    shiftTolerance:SHIFT,maxAddressesReported:MAX_ADDRESSES});
   const adapterTime=Date.now()-t0;
   const adapterRun=adapterRecorder.finish();
   const independentRecorder=recordingDriver(plain);
   const t1=Date.now();
   const independent=independentTrain(independentRecorder,starts,{mask,neutralMask:0,
    alternativeMask:alternative,pulses,hold:TRAIN_HOLD,release:TRAIN_RELEASE,
    shiftTolerance:SHIFT,maxRamBytes:2048});
   const independentTime=Date.now()-t1;
   const independentRun=independentRecorder.finish();
   const armScheduleMatch=adapterRun.arms.length===independentRun.arms.length
    &&adapterRun.arms.every((arm,i)=>same(arm.schedule,independentRun.arms[i].schedule));
   const armHashMatch=adapterRun.arms.length===independentRun.arms.length
    &&adapterRun.arms.every((arm,i)=>arm.endHash===independentRun.arms[i].endHash);
   const perStart=comparePerStart(independent,adapted);
   const hashMatch=independent.perStart.every((e,i)=>e.status!=='OBSERVED'
    ||(adapted.perStart[i]&&e.actionHash===adapted.perStart[i].actionHash
       &&e.neutralHash===adapted.perStart[i].neutralHash));
   const confirmedMatch=sameSet(independent.confirmed,adapted.confirmed.map(e=>e.address));
   const contradictedMatch=sameSet(independent.contradicted,adapted.contradicted.map(e=>e.address));
   const equivalent=setsAgree(perStart)&&confirmedMatch&&contradictedMatch&&hashMatch
    &&armScheduleMatch&&armHashMatch
    &&adapterRun.totalFrames===independentRun.totalFrames
    &&independent.usableStarts===adapted.usableStarts;
   rows.push({series:'T2c',seed,pulses,hold:TRAIN_HOLD,release:TRAIN_RELEASE,
    frames:pulses*(TRAIN_HOLD+TRAIN_RELEASE),mask,alternative,shiftTolerance:SHIFT,
    equivalent,hashMatch,confirmedMatch,contradictedMatch,
    armScheduleMatch,armHashMatch,
    armCount:{adapter:adapterRun.arms.length,independent:independentRun.arms.length},
    framesEmulated:{adapter:adapterRun.totalFrames,independent:independentRun.totalFrames},
    reference:'an independent reimplementation in this file; the standard detector cannot express a train',
    actionAndNeutralHashes:independent.perStart.map((e,i)=>({startIndex:i,
     independentAction:e.actionHash||null,
     adapterAction:adapted.perStart[i]?adapted.perStart[i].actionHash:null,
     independentNeutral:e.neutralHash||null,
     adapterNeutral:adapted.perStart[i]?adapted.perStart[i].neutralHash:null})),
    independentConfirmed:independent.confirmed.slice(0,16),
    adapterConfirmed:adapted.confirmed.map(e=>e.address).slice(0,16),
    wallClockMs:{adapter:adapterTime,independent:independentTime},
    adapterFramesRun:adapted.framesRun,
    perStart,
    divergenceDetail:equivalent?null:{
     armsDiffering:adapterRun.arms.map((arm,i)=>({index:i,
      scheduleAdapter:arm.schedule,
      scheduleIndependent:independentRun.arms[i]?independentRun.arms[i].schedule:null,
      hashMatch:independentRun.arms[i]?arm.endHash===independentRun.arms[i].endHash:false}))
      .filter(e=>!e.hashMatch||!same(e.scheduleAdapter,e.scheduleIndependent)).slice(0,8),
     setDivergence:perStart.filter(e=>!(e.statusMatch&&e.attributedMatch
      &&e.rawMatch&&e.shiftExplainedMatch&&e.specificMatch&&e.sharedMatch))}});
   write();
  }
 }

 /* ---- the recorded limit: a release too small to carry the phase window ---- */
 let shiftLimit=null;
 try{
  const bytes=romOf(seeds[0]);
  const plain=bootHost(bytes).driver;
  const starts=buildStarts(plain).slice(0,1);
  Adapter.probe(plain,{kind:'train',starts,mask:2,neutralMask:0,alternativeMask:1,
   pulses:4,hold:4,release:2,shiftTolerance:3,maxAddressesReported:MAX_ADDRESSES});
  shiftLimit={refused:false,
   note:'a release of 2 accepted a shift tolerance of 3, which it cannot absorb'};
 }catch(problem){shiftLimit={refused:true,error:problem.message,
  note:'a train whose release is smaller than the shift tolerance cannot carry a negative phase window. The adapter refuses it by name rather than silently shortening the window; this is why T2b runs at shiftTolerance 0.'};}
 report.recordedLimit=shiftLimit;

 const bySeries={};
 for(const r of rows){
  bySeries[r.series]=bySeries[r.series]||{trials:0,equivalent:0};
  bySeries[r.series].trials++;
  if(r.equivalent)bySeries[r.series].equivalent++;
 }
 const equivalent=rows.filter(r=>r.equivalent).length;
 const gatePassed=equivalent===rows.length&&shiftLimit&&shiftLimit.refused===true;
 report.totals={trials:rows.length,equivalent,divergent:rows.length-equivalent,
  bySeries,gatePassed,
  totalFramesEmulated:rows.reduce((t,r)=>t+((r.framesEmulated&&r.framesEmulated.adapter)||r.adapterFramesRun||0),0),
  totalWallClockMs:rows.reduce((t,r)=>t+((r.wallClockMs&&(r.wallClockMs.adapter||0))||0),0),
  verdict:gatePassed
   ?'the adapter and the reference agree on every compared quantity, arm by arm, in all three series: the synthetic trials may start and RECOVERED_BY_CADENCE may be used'
   :'DIVERGENCE: both results are kept, the cause must be localised, and RECOVERED_BY_CADENCE is withheld until then (ADAPTER_DIVERGENCE_UNRESOLVED)'};
 report.status=gatePassed?'PASS':'DIVERGENT';write();
 console.log(JSON.stringify({type:report.type,version:report.version,
  status:report.status,totals:report.totals,recordedLimit:report.recordedLimit},null,1));
 if(!gatePassed)process.exitCode=1;
}catch(problem){report.status='FAIL';report.error=problem.message;write();throw problem;}
